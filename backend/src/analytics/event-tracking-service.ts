/**
 * Internal Event Tracking v1 — the write-side service.
 *
 * `trackEvent()` is fire-and-forget from the caller's perspective:
 *   - never throws into a user-facing request path
 *   - returns `void` even on internal failure (logged, not raised)
 *   - respects `EVENT_TRACKING_ENABLED` (no-op when false)
 *   - sanitises metadata + trims oversized strings before hitting the DB
 *
 * Anti-inflation:
 *   - Repeat `property_view` from the same session for the same property
 *     within `DEDUP_WINDOW_MS` is silently deduped so refresh-spam +
 *     bot loops can't distort the feed / engagement counters.
 *
 * Writes land in the existing `UserEvent` Prisma table (columns
 * `eventType` for the name, `anonymousSessionId` for the client
 * session token). This service adds NO new columns — the schema is
 * unchanged.
 */

import { getPrisma } from '../db.js';
import { config } from '../config.js';
import {
  isTrackableEvent,
  EVENT_LIMITS,
  METADATA_ALLOWED_KEYS,
  type TrackableEvent,
} from './event-types.js';

export type TrackEventInput = {
  eventName: TrackableEvent | string;   // string accepted only so validation lives IN this service
  userId?: string | null;
  sessionId?: string | null;
  propertyId?: string | null;
  city?: string | null;
  district?: string | null;
  propertyType?: string | null;
  listingType?: string | null;
  searchQuery?: string | null;
  metadata?: Record<string, unknown> | null;
};

const DEDUP_WINDOW_MS = 45 * 1000; // per session+property for `property_view` / `feed_impression`

// Simple in-memory dedup cache. Keyed by session|user + property + event.
// Falls back to the DB check only when the cache miss happens.
const _dedup = new Map<string, number>();
const DEDUP_CACHE_MAX = 5000;

function dedupKey(input: TrackEventInput): string | null {
  if (input.eventName !== 'property_view' && input.eventName !== 'feed_impression') return null;
  const owner = input.userId ?? input.sessionId ?? '';
  const prop = input.propertyId ?? '';
  if (!owner || !prop) return null;
  return `${owner}|${prop}|${input.eventName}`;
}

function truthy<T>(v: T | null | undefined | ''): T | null {
  return v === null || v === undefined || v === '' ? null : v;
}

function trim(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function isPlainScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Sanitise + size-limit the metadata blob.
 *
 * We drop anything not in `METADATA_ALLOWED_KEYS`, coerce filter values
 * to shallow scalars, truncate long strings, and finally serialise to
 * make sure the JSON payload stays under EVENT_LIMITS.metadataBytesMax.
 */
export function sanitizeEventMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of METADATA_ALLOWED_KEYS) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === null || v === undefined) continue;
    if (key === 'query' && typeof v === 'string') {
      out[key] = v.slice(0, EVENT_LIMITS.searchQueryMax);
    } else if (key === 'filters' && typeof v === 'object' && !Array.isArray(v)) {
      const inner: Record<string, string | number | boolean> = {};
      for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) {
        if (isPlainScalar(fv)) {
          inner[fk.slice(0, 40)] = typeof fv === 'string' ? fv.slice(0, 100) : fv;
        }
      }
      out[key] = inner;
    } else if (isPlainScalar(v)) {
      // General scalar values — trim strings to a sane bound.
      out[key] = typeof v === 'string' ? v.slice(0, 200) : v;
    } else if (Array.isArray(v)) {
      // Only allow small arrays of scalars.
      const arr = v.slice(0, 20).filter(isPlainScalar);
      out[key] = arr;
    }
  }
  // Enforce serialised size cap by JSON length.
  const serialised = JSON.stringify(out);
  if (Buffer.byteLength(serialised, 'utf8') > EVENT_LIMITS.metadataBytesMax) {
    // Payload too fat — drop rather than truncate structurally.
    return { _oversized: true };
  }
  return out;
}

/**
 * Record a single event. Best-effort; never throws.
 * Callers should NOT `await` this in a critical path — it's designed
 * as fire-and-forget. Doing `void trackEvent(...)` is fine.
 */
export async function trackEvent(input: TrackEventInput): Promise<void> {
  try {
    if (!config.EVENT_TRACKING_ENABLED) return;
    if (!isTrackableEvent(input.eventName)) return; // silent reject for unknown names

    // Presence rule: at least one identity signal.
    const userId = truthy(input.userId ?? null);
    const sessionId = trim(input.sessionId ?? null, EVENT_LIMITS.sessionIdMax);
    if (!userId && !sessionId) return;

    // Client-side dedup for high-frequency events.
    const dk = dedupKey({ ...input, sessionId });
    const now = Date.now();
    if (dk) {
      const last = _dedup.get(dk);
      if (typeof last === 'number' && now - last < DEDUP_WINDOW_MS) return;
      // Bounded cache eviction (simple: reset when it gets too big).
      if (_dedup.size > DEDUP_CACHE_MAX) _dedup.clear();
      _dedup.set(dk, now);
    }

    const metadata = sanitizeEventMetadata(input.metadata ?? {});

    await getPrisma().userEvent.create({
      data: {
        userId,
        anonymousSessionId: userId ? null : sessionId,
        eventType: input.eventName,
        propertyId: trim(input.propertyId ?? null, EVENT_LIMITS.propertyIdMax),
        city: trim(input.city ?? null, EVENT_LIMITS.cityMax),
        district: trim(input.district ?? null, EVENT_LIMITS.districtMax),
        propertyType: trim(input.propertyType ?? null, EVENT_LIMITS.propertyTypeMax),
        purpose: trim(input.listingType ?? null, EVENT_LIMITS.listingTypeMax),
        priceHalalahs: null,
        metadata: JSON.stringify(metadata),
      },
    });
  } catch (err) {
    // Analytics is best-effort — a failed insert must never break the
    // user's actual request. Log at warn so ops can see spikes.
    // eslint-disable-next-line no-console
    console.warn('[analytics] trackEvent insert failed:', (err as Error)?.message ?? 'unknown');
  }
}

/** Test-only helper — reset the dedup cache between tests. Not exported through index. */
export function _resetDedupCacheForTests(): void { _dedup.clear(); }
