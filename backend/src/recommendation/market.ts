/**
 * Market Pulse — time-windowed aggregations over the UserEvent stream.
 *
 * V1 exposes three high-level signals:
 *   1. `pulse`             — per-city / per-district counters for a window
 *   2. `trending-areas`    — growth rate of engagement between the last
 *                            window and the window before it
 *   3. `trending-properties` — hot listings ranked by time-decayed weight
 *
 * All queries respect a minimum sample size (config). When a slice has
 * fewer events than that, we return `status: 'insufficient_data'` instead
 * of a misleading percentage — a small denominator makes any growth
 * number meaningless.
 */

import { EVENT_WEIGHTS, type EventType } from './events.js';

export type Period = '24h' | '7d' | '30d';

export function periodMs(p: Period): number {
  switch (p) {
    case '24h': return 24 * 60 * 60 * 1000;
    case '7d':  return 7 * 24 * 60 * 60 * 1000;
    case '30d': return 30 * 24 * 60 * 60 * 1000;
  }
}

/** Bounds for the last `period` and the window before it (same length). */
export function periodBounds(p: Period, now: Date = new Date()): {
  currentStart: Date; currentEnd: Date;
  previousStart: Date; previousEnd: Date;
} {
  const len = periodMs(p);
  const currentEnd = now;
  const currentStart = new Date(now.getTime() - len);
  const previousEnd = currentStart;
  const previousStart = new Date(currentStart.getTime() - len);
  return { currentStart, currentEnd, previousStart, previousEnd };
}

/**
 * Growth calculation guarded against divide-by-zero + tiny denominators.
 * Returns null when the previous window has no events at all — showing
 * "+∞" or "+9999%" for "1 event this week vs 0 last week" is misleading.
 */
export function growthRate(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Sample size check — fewer than N events = statistically noisy. */
export function isEnoughSamples(count: number, minSampleSize: number): boolean {
  return count >= minSampleSize;
}

/** Time-decayed weight for trending-properties. Fresh = full weight. */
export function decayedEventWeight(
  eventType: string,
  createdAt: Date,
  now: Date,
  halfLifeMs: number,
): number {
  const base = (EVENT_WEIGHTS as Record<string, number>)[eventType];
  if (typeof base !== 'number' || base === 0) return 0;
  const ageMs = Math.max(0, now.getTime() - createdAt.getTime());
  const decay = Math.pow(0.5, ageMs / halfLifeMs);
  return base * decay;
}

/** Property-comparison price band: median ±35% for the same category. */
export type PriceOpportunity =
  | { status: 'insufficient_data' }
  | { status: 'ok'; sampleSize: number; median: number; band: [number, number]; label: 'below_market' | 'at_market' | 'above_market' };

export function classifyPriceOpportunity(
  targetPriceHalalahs: number,
  comparablePricesHalalahs: number[],
  minSampleSize: number,
): PriceOpportunity {
  if (comparablePricesHalalahs.length < minSampleSize) return { status: 'insufficient_data' };
  const sorted = [...comparablePricesHalalahs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
  const band: [number, number] = [median * 0.85, median * 1.15];
  let label: 'below_market' | 'at_market' | 'above_market';
  if (targetPriceHalalahs < band[0]) label = 'below_market';
  else if (targetPriceHalalahs > band[1]) label = 'above_market';
  else label = 'at_market';
  return { status: 'ok', sampleSize: comparablePricesHalalahs.length, median, band, label };
}

/** Types used by the API layer to shape responses without leaking rows. */
export type TrendingArea = {
  city: string;
  district: string | null;
  currentEvents: number;
  previousEvents: number;
  growthPercent: number | null;
  status: 'ok' | 'insufficient_data';
  sampleSize: number;
};

export type TrendingProperty = {
  propertyId: string;
  score: number;             // time-decayed weight sum
  eventCount: number;
};
