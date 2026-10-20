/**
 * Recommendation scorer — deterministic, explainable, no ML.
 *
 * Score components (weights sum to 100):
 *   30  explicit user affinity  — was this property saved / contacted / opened?
 *   20  location match          — city + district vs profile top preferences
 *   15  property type match     — category matches profile preference
 *   10  listing type match      — purpose matches profile preference
 *   10  freshness               — recent listings preferred
 *   10  quality                 — reuses services/property-quality-score
 *    5  engagement / popularity — hides raw counts, uses normalised value
 *
 * Never throws. Missing fields → neutral (not zero) so a schema gap
 * cannot bury a legitimate listing.
 *
 * `reasons` is a debug-only trace. Routes strip / rename it in prod.
 */

import { calculatePropertyQualityScore } from '../services/property-quality-score.js';
import type { RecommendationContext, RecommendationReason, UserInterestProfile } from './recommendation-types.js';

const W = {
  affinity: 30,
  location: 20,
  propertyType: 15,
  listingType: 10,
  freshness: 10,
  quality: 10,
  engagement: 5,
} as const;

function daysSince(when: unknown): number {
  if (!when) return Infinity;
  const t = when instanceof Date ? when.getTime() : new Date(when as string | number).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

function normEq(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 0..1 based on where a weight sits within the profile's top-N range. */
function weightRankScore(weights: Record<string, number>, value: unknown): number {
  if (!value || typeof value !== 'string') return 0.5; // neutral
  const entries = Object.entries(weights);
  if (entries.length === 0) return 0.5;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return 0.5;
  const own = weights[value] ?? 0;
  return Math.max(0, Math.min(1, own / total * entries.length));
}

function freshness01(property: any): number {
  const d = daysSince(property?.publishedAt ?? property?.createdAt);
  if (d <= 3) return 1;
  if (d >= 60) return 0.15;
  return 1 - (d - 3) / 63;
}

function affinity01(property: any, profile: UserInterestProfile): number {
  const id = property?.id;
  if (typeof id === 'string' && profile.preferredPropertyIds.includes(id)) {
    // Explicit affinity is heavy — the user directly engaged with this one.
    return 1;
  }
  // No direct hit; base affinity on attribute-weight sums, capped at .6 so
  // an inferred match can't tie an explicit engagement.
  const parts = [
    weightRankScore(profile.cityWeights, property?.city),
    weightRankScore(profile.propertyTypeWeights, property?.category ?? property?.propertyType),
  ];
  return Math.min(0.6, parts.reduce((a, b) => a + b, 0) / parts.length);
}

function locationMatch01(property: any, profile: UserInterestProfile, ctx?: RecommendationContext): number {
  // Current request context outweighs stale history per spec.
  if (ctx?.city && normEq(property?.city, ctx.city)) return 1;
  if (ctx?.district && normEq(property?.district ?? property?.neighborhood, ctx.district)) return 1;
  return weightRankScore(profile.cityWeights, property?.city);
}

function typeMatch01(property: any, profile: UserInterestProfile, ctx?: RecommendationContext): number {
  if (ctx?.propertyType && normEq(property?.category ?? property?.propertyType, ctx.propertyType)) return 1;
  return weightRankScore(profile.propertyTypeWeights, property?.category ?? property?.propertyType);
}

function listingMatch01(property: any, profile: UserInterestProfile, ctx?: RecommendationContext): number {
  if (ctx?.listingType && normEq(property?.purpose ?? property?.listingType, ctx.listingType)) return 1;
  return weightRankScore(profile.listingTypeWeights, property?.purpose ?? property?.listingType);
}

/** 0..1 — property price fit against the request's min/max band. Neutral (0.5) when either side missing. */
function priceFit01(property: any, ctx?: RecommendationContext): number {
  if (!ctx || (ctx.minPrice === undefined && ctx.maxPrice === undefined)) return 0.5;
  const raw = property?.price ?? property?.priceHalalahs ?? property?.dailyRate;
  const price = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  if (price === null || price <= 0) return 0.5;
  const min = ctx.minPrice ?? 0;
  const max = ctx.maxPrice ?? Number.POSITIVE_INFINITY;
  if (price < min || price > max) return 0;
  return 1;
}

function engagement01(property: any): number {
  // Uses whatever counters the row happens to carry; neutral if none.
  const saves = Math.max(0, Number(property?.savesCount ?? property?._count?.saves ?? 0) || 0);
  const contacts = Math.max(0, Number(property?.contactsCount ?? property?._count?.contacts ?? 0) || 0);
  const views = Math.max(0, Number(property?.viewsCount ?? property?._count?.views ?? 0) || 0);
  if (saves + contacts + views === 0) return 0.4;
  // Log scale so viral listings can't dominate.
  return Math.min(1, Math.log10(1 + saves * 3 + contacts * 4 + views) / 3);
}

export type RecommendationScoreResult = {
  score: number;
  reasons: RecommendationReason[];
};

export function calculateRecommendationScore(
  property: any,
  profile: UserInterestProfile,
  ctx?: RecommendationContext,
): RecommendationScoreResult {
  try {
    const reasons: RecommendationReason[] = [];

    const affinity = affinity01(property, profile);
    const location = locationMatch01(property, profile, ctx);
    const type = typeMatch01(property, profile, ctx);
    const listing = listingMatch01(property, profile, ctx);
    const fresh = freshness01(property);
    const quality = calculatePropertyQualityScore(property).total / 100;
    const eng = engagement01(property);
    const price = priceFit01(property, ctx);

    // ---- Reasons (debug only) ----
    const id = property?.id;
    if (typeof id === 'string' && profile.preferredPropertyIds.includes(id)) reasons.push('based_on_viewed');
    if (ctx?.city && normEq(property?.city, ctx.city)) reasons.push('city_match');
    else if (property?.city && (profile.cityWeights[property.city] ?? 0) > 0) reasons.push('city_match');
    if (ctx?.district && normEq(property?.district ?? property?.neighborhood, ctx.district)) reasons.push('district_match');
    else if ((property?.district || property?.neighborhood) && (profile.districtWeights[property?.district ?? property?.neighborhood] ?? 0) > 0) reasons.push('district_match');
    if (ctx?.propertyType && normEq(property?.category ?? property?.propertyType, ctx.propertyType)) reasons.push('property_type_match');
    else if ((property?.category || property?.propertyType) && (profile.propertyTypeWeights[property?.category ?? property?.propertyType] ?? 0) > 0) reasons.push('property_type_match');
    if (ctx?.listingType && normEq(property?.purpose ?? property?.listingType, ctx.listingType)) reasons.push('listing_type_match');
    if (price === 1 && ctx && (ctx.minPrice !== undefined || ctx.maxPrice !== undefined)) reasons.push('similar_price');
    if (fresh >= 0.8) reasons.push('fresh_listing');
    if (quality >= 0.8) reasons.push('high_quality');
    if (profile.confidence === 0) reasons.push('cold_start');

    // Price fit modulates the listing-type contribution when the caller
    // provided a min/max band — a mismatched price halves the listing
    // signal, a match preserves it. Missing band → neutral (no effect).
    // This keeps the top-level weights unchanged while letting the price
    // band influence ranking without introducing a new weight slot.
    const listingBlended =
      ctx && (ctx.minPrice !== undefined || ctx.maxPrice !== undefined)
        ? listing * (0.5 + 0.5 * price)
        : listing;

    const raw =
      affinity * W.affinity +
      location * W.location +
      type * W.propertyType +
      listingBlended * W.listingType +
      fresh * W.freshness +
      quality * W.quality +
      eng * W.engagement;

    const score = Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;
    return { score, reasons: [...new Set(reasons)] };
  } catch {
    // Never let a bad row nuke the whole feed.
    return { score: 15, reasons: ['cold_start'] };
  }
}
