/**
 * Similar-property finder — property-vs-property similarity for the
 * "عقارات مشابهة" panel. Deterministic, cheap, schema-tolerant.
 *
 * Signals (all optional; missing signals degrade gracefully):
 *   same property type          40
 *   same listing type / purpose 20
 *   same city                   15
 *   same district / neighborhood 15
 *   similar bedrooms (±1)       10 (if both known)
 *   similar area   (±25%)       10 (if both known)
 *   similar price  (±25%)       10 (if both known)
 *   quality + freshness         soft tie-breakers
 *
 * Callers pass an already-fetched `pool` — usually a bounded slice
 * from Prisma — so the pure math here can be unit-tested without a DB.
 */

import { calculatePropertyQualityScore } from '../services/property-quality-score.js';

function daysSince(when: unknown): number {
  if (!when) return Infinity;
  const t = when instanceof Date ? when.getTime() : new Date(when as string | number).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'bigint' && v > 0n) return Number(v);
  return null;
}

function within(a: number, b: number, pct: number): boolean {
  if (b === 0) return false;
  return Math.abs(a - b) / b <= pct;
}

function normEq(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export type SimilarityResult = { property: unknown; score: number };

export function scoreSimilarity(target: any, candidate: any): number {
  try {
    if (!target || !candidate) return 0;
    if (target.id && candidate.id && target.id === candidate.id) return -1; // exclude self
    let s = 0;
    if (normEq(target.category ?? target.propertyType, candidate.category ?? candidate.propertyType)) s += 40;
    if (normEq(target.purpose ?? target.listingType, candidate.purpose ?? candidate.listingType)) s += 20;
    if (normEq(target.city, candidate.city)) s += 15;
    if (normEq(target.district ?? target.neighborhood, candidate.district ?? candidate.neighborhood)) s += 15;

    const tRooms = num(target.bedrooms ?? target.rooms);
    const cRooms = num(candidate.bedrooms ?? candidate.rooms);
    if (tRooms !== null && cRooms !== null && Math.abs(tRooms - cRooms) <= 1) s += 10;

    const tArea = num(target.area ?? target.size);
    const cArea = num(candidate.area ?? candidate.size);
    if (tArea !== null && cArea !== null && within(cArea, tArea, 0.25)) s += 10;

    const tPrice = num(target.price ?? target.dailyRate);
    const cPrice = num(candidate.price ?? candidate.dailyRate);
    if (tPrice !== null && cPrice !== null && within(cPrice, tPrice, 0.25)) s += 10;

    // Soft tie-breakers — never dominate.
    const quality = calculatePropertyQualityScore(candidate).total / 100;
    const fresh = daysSince(candidate.publishedAt ?? candidate.createdAt) <= 30 ? 1 : 0.5;
    s += quality * 3 + fresh * 2;

    return Math.max(0, Math.min(100, Math.round(s * 10) / 10));
  } catch {
    return 0;
  }
}

/**
 * Rank `pool` by similarity to `target` and return the top `limit`.
 * Filters self, hidden, and non-published listings out of the result.
 */
export function rankSimilar(target: any, pool: any[], limit = 12): SimilarityResult[] {
  return pool
    .filter((p) => {
      if (!p || p === target || p.id === target?.id) return false;
      // Respect basic visibility if the pool wasn't already filtered upstream.
      if (p.status && p.status !== 'available') return false;
      return true;
    })
    .map((p) => ({ property: p, score: scoreSimilarity(target, p) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(50, limit)));
}
