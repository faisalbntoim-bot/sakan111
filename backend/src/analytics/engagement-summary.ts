/**
 * Per-property engagement summary — aggregate counts of the current
 * tracked events for one property. Bounded to a lookback window so it
 * remains cheap on large tables.
 *
 * Never exposes raw rows. Never returns per-user activity.
 */

import { getPrisma } from '../db.js';

export type PropertyEngagementSummary = {
  propertyId: string;
  windowDays: number;
  views: number;
  saves: number;
  unsaves: number;
  shares: number;
  contacts: number;
  galleryOpens: number;
  mapOpens: number;
  tourOpens: number;
  reports: number;
  hides: number;
};

const EVENT_TO_FIELD: Record<string, keyof Omit<PropertyEngagementSummary, 'propertyId' | 'windowDays'>> = {
  property_view: 'views',
  property_save: 'saves',
  property_unsave: 'unsaves',
  property_share: 'shares',
  property_contact: 'contacts',
  property_call: 'contacts',
  property_whatsapp: 'contacts',
  property_open_gallery: 'galleryOpens',
  property_open_map: 'mapOpens',
  property_open_tour: 'tourOpens',
  property_report: 'reports',
  property_hide: 'hides',
};

export async function getPropertyEngagementSummary(
  propertyId: string,
  windowDays = 30,
): Promise<PropertyEngagementSummary> {
  const empty: PropertyEngagementSummary = {
    propertyId,
    windowDays,
    views: 0, saves: 0, unsaves: 0, shares: 0, contacts: 0,
    galleryOpens: 0, mapOpens: 0, tourOpens: 0, reports: 0, hides: 0,
  };
  if (!propertyId) return empty;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await getPrisma().userEvent.groupBy({
    by: ['eventType'],
    where: {
      propertyId,
      createdAt: { gte: since },
      eventType: { in: Object.keys(EVENT_TO_FIELD) },
    },
    _count: { _all: true },
  });
  const out = { ...empty };
  for (const r of rows) {
    const field = EVENT_TO_FIELD[r.eventType];
    if (field) {
      const cur = out[field] ?? 0;
      out[field] = cur + r._count._all;
    }
  }
  return out;
}
