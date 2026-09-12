/**
 * Read-side helpers that turn the raw UserEvent stream into small,
 * bounded, feed-ranker-friendly summaries. Prep for Smart Feed v2 —
 * intentionally NOT wired into the ranker yet.
 *
 * Every function is bounded by a `limit` and time window so a chatty
 * user cannot make one call unbounded. Never returns raw event rows.
 */

import { getPrisma } from '../db.js';

const DEFAULT_LOOKBACK_DAYS = 30;

type Bounds = { since: Date };

function boundsFor(days: number = DEFAULT_LOOKBACK_DAYS): Bounds {
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
}

/**
 * Most-recent distinct property IDs the user has *engaged* with
 * (viewed, saved, contacted, opened gallery/map/tour). De-duped and
 * ordered by recency.
 */
export async function getRecentUserInterestSignals(
  userId: string,
  limit = 20,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
): Promise<{
  viewedPropertyIds: string[];
  savedPropertyIds: string[];
  preferredCities: string[];
  preferredDistricts: string[];
  preferredPropertyTypes: string[];
}> {
  if (!userId) return { viewedPropertyIds: [], savedPropertyIds: [], preferredCities: [], preferredDistricts: [], preferredPropertyTypes: [] };
  const cap = Math.max(1, Math.min(200, limit));
  const { since } = boundsFor(lookbackDays);
  const rows = await getPrisma().userEvent.findMany({
    where: {
      userId,
      createdAt: { gte: since },
      eventType: { in: ['property_view', 'property_save', 'property_open_gallery', 'property_open_map', 'property_open_tour', 'property_contact'] },
    },
    select: { eventType: true, propertyId: true, city: true, district: true, propertyType: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: cap * 4, // pull a bit more so we have material to dedupe on
  });

  const viewed = new Set<string>();
  const saved = new Set<string>();
  const cityCounts = new Map<string, number>();
  const districtCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();

  for (const r of rows) {
    if (r.propertyId) {
      if (r.eventType === 'property_view' && viewed.size < cap) viewed.add(r.propertyId);
      if (r.eventType === 'property_save' && saved.size < cap) saved.add(r.propertyId);
    }
    if (r.city) cityCounts.set(r.city, (cityCounts.get(r.city) ?? 0) + 1);
    if (r.district) districtCounts.set(r.district, (districtCounts.get(r.district) ?? 0) + 1);
    if (r.propertyType) typeCounts.set(r.propertyType, (typeCounts.get(r.propertyType) ?? 0) + 1);
  }
  const topKeys = (m: Map<string, number>, n = 5) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return {
    viewedPropertyIds: [...viewed],
    savedPropertyIds: [...saved],
    preferredCities: topKeys(cityCounts),
    preferredDistricts: topKeys(districtCounts),
    preferredPropertyTypes: topKeys(typeCounts),
  };
}
