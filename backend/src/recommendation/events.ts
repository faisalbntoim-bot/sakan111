/**
 * Recommendation & analytics — event whitelist + weights + metadata schema.
 *
 * All weights live in this one file so we can tune the system by editing
 * a single config, not chasing hard-coded numbers through routes.
 *
 * Weights represent "how strongly does this event signal user interest in
 * a property?" — negative weights are anti-signals (PROPERTY_HIDE means
 * the user actively rejected the listing).
 *
 * Privacy: `EVENT_METADATA_ALLOWED_KEYS` is the ONLY set of metadata keys
 * we accept from clients. Anything else in a POST body is stripped at the
 * route boundary before it reaches the database.
 */

export const EVENT_TYPES = [
  'PROPERTY_IMPRESSION',
  'PROPERTY_VIEW',
  'PROPERTY_VIEW_DURATION',
  'SEARCH',
  'FILTER_APPLIED',
  'PHOTO_OPEN',
  'MAP_OPEN',
  'TOUR_OPEN',
  'PROPERTY_SAVE',
  'PROPERTY_UNSAVE',
  'PROPERTY_SHARE',
  'CONTACT_OWNER',
  'CONTACT_OFFICE',
  'BOOKING_START',
  'BOOKING_COMPLETE',
  'PROPERTY_HIDE',
] as const;

export type EventType = typeof EVENT_TYPES[number];

/**
 * Signal strength per event, used by the preference profile aggregator.
 * Tune here — nowhere else — when calibrating the algorithm.
 */
export const EVENT_WEIGHTS: Record<EventType, number> = {
  PROPERTY_IMPRESSION: 0,
  PROPERTY_VIEW: 1,
  PROPERTY_VIEW_DURATION: 2,
  SEARCH: 0,
  FILTER_APPLIED: 0,
  PHOTO_OPEN: 2,
  MAP_OPEN: 2,
  TOUR_OPEN: 3,
  PROPERTY_SAVE: 5,
  PROPERTY_UNSAVE: -2,
  PROPERTY_SHARE: 6,
  CONTACT_OWNER: 8,
  CONTACT_OFFICE: 8,
  BOOKING_START: 12,
  BOOKING_COMPLETE: 25,
  PROPERTY_HIDE: -10,
};

/**
 * Only these keys survive validation and reach the DB metadata column.
 * Anything else is dropped so a malicious client cannot exfiltrate
 * arbitrary state into our analytics store.
 */
export const EVENT_METADATA_ALLOWED_KEYS = [
  'searchTerm',        // string, ≤200 chars — for SEARCH
  'filters',           // object of scalar values — for FILTER_APPLIED
  'durationMs',        // integer ≥0 — for PROPERTY_VIEW_DURATION
  'photoIndex',        // integer ≥0
  'source',            // string, ≤40 chars — 'feed' | 'search' | 'saved' | 'market' …
  'referrerPropertyId',
] as const;

export type EventMetadataKey = typeof EVENT_METADATA_ALLOWED_KEYS[number];

export function isEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * Prune a metadata object to only whitelisted keys, and coerce known-type
 * fields so a malformed value cannot poison downstream aggregations.
 */
export function sanitizeMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of EVENT_METADATA_ALLOWED_KEYS) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === null || v === undefined) continue;
    if (key === 'searchTerm' && typeof v === 'string') {
      out[key] = v.slice(0, 200);
    } else if (key === 'source' && typeof v === 'string') {
      out[key] = v.slice(0, 40);
    } else if (key === 'durationMs' && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[key] = Math.round(v);
    } else if (key === 'photoIndex' && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[key] = Math.round(v);
    } else if (key === 'referrerPropertyId' && typeof v === 'string') {
      out[key] = v.slice(0, 40);
    } else if (key === 'filters' && typeof v === 'object' && !Array.isArray(v)) {
      // Filters is an object of scalars; drop nested objects/arrays.
      const filtersOut: Record<string, string | number | boolean> = {};
      for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof fv === 'string' || typeof fv === 'number' || typeof fv === 'boolean') {
          filtersOut[fk.slice(0, 40)] = typeof fv === 'string' ? fv.slice(0, 100) : fv;
        }
      }
      out[key] = filtersOut;
    }
  }
  return out;
}
