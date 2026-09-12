/**
 * Feed Ranking V1 — deterministic, dependency-free scorer.
 *
 * Combines Property Quality Score with a handful of match/context
 * signals to produce a per-property `score` in ~0..100. Signals we do
 * NOT have (personalised user history, market valuation, external
 * analytics) are intentionally absent — this is v1. When those signals
 * arrive later, extend `SIGNAL_KEYS` and the score formula rather than
 * inventing a stand-in here.
 *
 * The `reasons` array is a debug-only trace for admin views + tests;
 * routes must strip it before responding in production (see the
 * `sort=smart` handler in routes/properties.ts).
 */

import { calculatePropertyQualityScore } from './property-quality-score.js';

export type FeedContext = {
  city?: string;
  district?: string;
  propertyType?: string;
  listingType?: string;
  minPrice?: number;
  maxPrice?: number;
  bedrooms?: number;
};

export type FeedScoreResult = {
  score: number;
  qualityScore: number;
  reasons: string[];
};

/** Weights on the components. Sum equals 1.0 by construction. */
const W = {
  relevance: 0.30,
  locationMatch: 0.20,
  freshness: 0.15,
  quality: 0.15,
  engagement: 0.10,
  priceMatch: 0.05,
  advertiserTrust: 0.05,
} as const;

// ---- Small helpers ---------------------------------------------------

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

function positiveNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'bigint' && v > 0n) return Number(v);
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// ---- Component scores (all 0..1 unless noted) ------------------------

function freshnessScore(property: any): number {
  const d = daysSince(property?.publishedAt ?? property?.createdAt);
  if (d <= 3) return 1;
  if (d >= 60) return 0;
  return Math.max(0, 1 - (d - 3) / 57);
}

/** Location match: 1 for city+district, .7 for city only, 0 otherwise. */
function locationMatchScore(property: any, ctx?: FeedContext): number {
  if (!ctx?.city && !ctx?.district) return 0.5; // neutral when the user hasn't filtered
  let s = 0;
  if (ctx?.city && normEq(property?.city, ctx.city)) s += 0.7;
  if (ctx?.district && normEq(property?.district ?? property?.neighborhood, ctx.district)) s += 0.3;
  return Math.max(0, Math.min(1, s));
}

function priceMatchScore(property: any, ctx?: FeedContext): number {
  const price = positiveNumber(property?.price ?? property?.dailyRate);
  if (price === null || ctx?.minPrice === undefined && ctx?.maxPrice === undefined) return 0.5;
  const min = ctx?.minPrice ?? 0;
  const max = ctx?.maxPrice ?? Number.POSITIVE_INFINITY;
  if (price < min || price > max) return 0;
  return 1;
}

function propertyTypeMatchScore(property: any, ctx?: FeedContext): number {
  if (!ctx?.propertyType && !ctx?.listingType) return 0.5;
  let s = 0;
  if (ctx?.propertyType && normEq(property?.category ?? property?.type, ctx.propertyType)) s += 0.7;
  if (ctx?.listingType && normEq(property?.purpose ?? property?.listingType, ctx.listingType)) s += 0.3;
  return Math.max(0, Math.min(1, s));
}

/**
 * "Relevance" for v1 = context-fit blend. When a user is logged in and
 * we later have their preferences vector, replace this with a similarity
 * lookup — the caller shape stays the same.
 */
function relevanceScore(property: any, ctx?: FeedContext): number {
  const parts = [
    propertyTypeMatchScore(property, ctx),
    locationMatchScore(property, ctx),
    priceMatchScore(property, ctx),
  ];
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

function engagementScore(property: any): number {
  const saves = Math.max(0, Number(property?.savesCount ?? property?._count?.saves ?? 0) || 0);
  const contacts = Math.max(0, Number(property?.contactsCount ?? property?._count?.contacts ?? 0) || 0);
  const views = Math.max(0, Number(property?.viewsCount ?? property?._count?.views ?? 0) || 0);
  if (saves + contacts + views === 0) return 0.4; // neutral if no counters exist yet
  // Log-scale views so a hot listing can't drown out relevance.
  const v = Math.min(1, Math.log10(1 + views) / 3);
  const s = Math.min(1, saves / 20);
  const c = Math.min(1, contacts / 10);
  return Math.max(0, Math.min(1, (v * 0.3 + s * 0.4 + c * 0.3)));
}

function advertiserTrustScore(property: any): number {
  const verified = !!(
    property?.owner?.verified ||
    property?.owner?.isVerified ||
    property?.office?.verified ||
    property?.advertiserVerification?.status === 'verified' ||
    property?.regaLicenseNumber
  );
  return verified ? 1 : 0.5;
}

// ---- Public API ------------------------------------------------------

export function calculateFeedScore(
  property: any,
  context?: FeedContext,
): FeedScoreResult {
  const quality = calculatePropertyQualityScore(property);
  const reasons: string[] = [];

  const relevance = relevanceScore(property, context);
  const location = locationMatchScore(property, context);
  const fresh = freshnessScore(property);
  const engagement = engagementScore(property);
  const price = priceMatchScore(property, context);
  const trust = advertiserTrustScore(property);
  const qualityNormalised = quality.total / 100;

  if (fresh >= 0.8) reasons.push('fresh_listing');
  if (quality.total >= 80) reasons.push('high_quality');
  if (context?.city && normEq(property?.city, context.city)) reasons.push('city_match');
  if (context?.district && normEq(property?.district ?? property?.neighborhood, context.district)) reasons.push('district_match');
  if (context && (context.minPrice !== undefined || context.maxPrice !== undefined) && price === 1) reasons.push('price_match');
  if (context?.propertyType && normEq(property?.category ?? property?.type, context.propertyType)) reasons.push('property_type_match');

  const score =
    relevance * W.relevance +
    location * W.locationMatch +
    fresh * W.freshness +
    qualityNormalised * W.quality +
    engagement * W.engagement +
    price * W.priceMatch +
    trust * W.advertiserTrust;

  return {
    score: Math.round(Math.max(0, Math.min(1, score)) * 100 * 10) / 10,
    qualityScore: quality.total,
    reasons,
  };
}
