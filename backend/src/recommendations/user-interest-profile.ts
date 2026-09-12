/**
 * Build a `UserInterestProfile` from the last 500 events (max) within
 * the last 90 days for a `userId` or an anonymous `sessionId`.
 *
 * Deterministic. Fully internal. Uses no ML / embeddings / external
 * services — just weighted event counts with recency decay.
 *
 * The weights + decay curve live here so tuning is a single-file
 * change. Nothing else needs to know these numbers.
 */

import { getPrisma } from '../db.js';
import type { UserInterestProfile } from './recommendation-types.js';

// Event → base weight. Positive = interest, negative = anti-signal.
const WEIGHTS: Record<string, number> = {
  property_save: 8,
  property_contact: 10,
  property_call: 10,
  property_whatsapp: 10,
  property_open_tour: 6,
  property_open_map: 4,
  property_open_gallery: 3,
  property_view: 2,
  feed_click: 2,
  property_share: 4,
  property_hide: -8,
  property_report: -20,
  property_unsave: -3,
};

const MEANINGFUL_EVENT_TYPES: string[] = Object.keys(WEIGHTS);
const LOOKBACK_DAYS = 90;
const MAX_EVENT_ROWS = 500;
const MAX_TOP_KEYS = 10;

/** Half-life-style step decay per the task spec. */
function recencyMultiplier(createdAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays <= 1)  return 1.00;
  if (ageDays <= 7)  return 0.85;
  if (ageDays <= 30) return 0.60;
  if (ageDays <= 90) return 0.35;
  return 0;
}

function topKeysDesc(m: Record<string, number>, limit = MAX_TOP_KEYS): Record<string, number> {
  return Object.fromEntries(
    Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, limit),
  );
}

function confidenceFromEventCount(n: number): number {
  if (n <= 0) return 0;
  if (n <= 3) return 25;
  if (n <= 10) return 55;
  if (n <= 30) return 80;
  return 95;
}

/**
 * Build a profile. Returns an empty (all-zeroes) profile for callers
 * with no identity — never throws.
 */
export async function buildUserInterestProfile(input: { userId?: string | null; sessionId?: string | null }): Promise<UserInterestProfile> {
  const empty: UserInterestProfile = {
    preferredPropertyIds: [],
    dislikedPropertyIds: [],
    cityWeights: {},
    districtWeights: {},
    propertyTypeWeights: {},
    listingTypeWeights: {},
    recentSearchTerms: [],
    confidence: 0,
  };
  if (!input.userId && !input.sessionId) return empty;

  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const where = input.userId
      ? { userId: input.userId, createdAt: { gte: since }, eventType: { in: MEANINGFUL_EVENT_TYPES } }
      : { anonymousSessionId: input.sessionId!, createdAt: { gte: since }, eventType: { in: MEANINGFUL_EVENT_TYPES } };

    const rows = await getPrisma().userEvent.findMany({
      where,
      select: {
        eventType: true, propertyId: true,
        city: true, district: true, propertyType: true, purpose: true,
        metadata: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_EVENT_ROWS,
    });

    const now = new Date();
    const preferredIds = new Set<string>();
    const dislikedIds = new Set<string>();
    const city: Record<string, number> = {};
    const district: Record<string, number> = {};
    const type: Record<string, number> = {};
    const listing: Record<string, number> = {};
    const searchTerms: string[] = [];
    let meaningful = 0;

    for (const r of rows) {
      const w = (WEIGHTS[r.eventType] ?? 0) * recencyMultiplier(r.createdAt, now);
      if (w === 0) continue;
      meaningful++;

      // Property-level signals
      if (r.propertyId) {
        if (w > 0 && (r.eventType === 'property_save' || r.eventType === 'property_contact' || r.eventType === 'property_call' || r.eventType === 'property_whatsapp' || r.eventType === 'property_open_tour')) {
          preferredIds.add(r.propertyId);
        }
        if (r.eventType === 'property_hide' || r.eventType === 'property_report') {
          dislikedIds.add(r.propertyId);
        }
      }

      // Attribute-level signals — only positive weights inflate preference.
      if (w > 0) {
        if (r.city) city[r.city] = (city[r.city] ?? 0) + w;
        if (r.district) district[r.district] = (district[r.district] ?? 0) + w;
        if (r.propertyType) type[r.propertyType] = (type[r.propertyType] ?? 0) + w;
        if (r.purpose) listing[r.purpose] = (listing[r.purpose] ?? 0) + w;
      }

      // Search terms — pluck from metadata `.query` if present.
      try {
        const meta = r.metadata ? JSON.parse(r.metadata) as { query?: unknown } : null;
        if (meta && typeof meta.query === 'string' && meta.query.trim().length > 0 && searchTerms.length < 10) {
          searchTerms.push(meta.query.slice(0, 100));
        }
      } catch { /* malformed metadata never breaks profile */ }
    }

    return {
      preferredPropertyIds: [...preferredIds].slice(0, MAX_TOP_KEYS),
      dislikedPropertyIds: [...dislikedIds],
      cityWeights: topKeysDesc(city),
      districtWeights: topKeysDesc(district),
      propertyTypeWeights: topKeysDesc(type),
      listingTypeWeights: topKeysDesc(listing),
      recentSearchTerms: searchTerms,
      confidence: confidenceFromEventCount(meaningful),
    };
  } catch {
    // A DB blip must never crash a recommendation request — cold-start.
    return empty;
  }
}
