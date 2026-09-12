/**
 * Property Quality Score V1 — deterministic scorer producing a 0..100
 * value with a component breakdown, used by the smart feed to prevent
 * incomplete listings from dominating results and to give the UI a
 * quality signal it can surface.
 *
 * Design constraints (from the task spec):
 *   - Zero Prisma schema changes: every input read is defensive
 *     (`property?.foo ?? fallback`). Missing fields fall back to a
 *     neutral score rather than penalising a legitimate listing that
 *     just doesn't populate an optional column.
 *   - No external services / AI / market-valuation.
 *   - Never throws. A malformed property row must not break the feed.
 *   - Same input → same output. No randomness anywhere.
 *
 * The `property` argument is typed `any` because callers may pass a
 * raw Prisma row, a snapshot from an aggregation query, or a shape
 * augmented with related-model fields. The scorer only touches the
 * fields it recognises.
 */

export type PropertyQualityBreakdown = {
  total: number;
  completeness: number;
  media: number;
  freshness: number;
  advertiserTrust: number;
  priceSignal: number;
  engagement: number;
};

const CLAMPS = {
  completeness: 25,
  media: 20,
  freshness: 15,
  advertiserTrust: 15,
  priceSignal: 15,
  engagement: 10,
} as const;

/** Clamp helper — never returns NaN, always within [0, max]. */
function clamp(v: unknown, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  if (n < 0) return 0;
  if (n > max) return max;
  return Math.round(n * 10) / 10;
}

function stringLen(v: unknown): number {
  return typeof v === 'string' ? v.length : 0;
}

function looksTruthyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
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

/** Advertiser-trust look-up: only counts if the field actually exists. */
function readVerifiedFlag(property: any): boolean {
  return !!(
    property?.owner?.verified ||
    property?.owner?.isVerified ||
    property?.office?.verified ||
    property?.advertiserVerification?.status === 'verified' ||
    property?.regaLicenseNumber
  );
}

function readImageCount(property: any): number {
  if (Array.isArray(property?.images)) return property.images.length;
  if (Array.isArray(property?.media)) return property.media.length;
  if (Array.isArray(property?.mediaAssets)) return property.mediaAssets.length;
  if (typeof property?._count?.mediaAssets === 'number') return property._count.mediaAssets;
  if (typeof property?.imageCount === 'number') return property.imageCount;
  return 0;
}

function readVideoFlag(property: any): boolean {
  if (property?.videoUrl && looksTruthyString(property.videoUrl)) return true;
  if (Array.isArray(property?.media) && property.media.some((m: any) => m?.kind === 'video')) return true;
  if (Array.isArray(property?.mediaAssets) && property.mediaAssets.some((m: any) => m?.kind === 'video')) return true;
  return false;
}

function readTourFlag(property: any): boolean {
  if (property?.tourUrl && looksTruthyString(property.tourUrl)) return true;
  if (property?.tour?.status === 'published' || property?.tour?.status === 'READY') return true;
  if (Array.isArray(property?.tours) && property.tours.length > 0) return true;
  return false;
}

function readEngagementCounters(property: any): { views: number; saves: number; contacts: number; shares: number } {
  return {
    views: Math.max(0, Number(property?.viewsCount ?? property?._count?.views ?? 0) || 0),
    saves: Math.max(0, Number(property?.savesCount ?? property?._count?.saves ?? 0) || 0),
    contacts: Math.max(0, Number(property?.contactsCount ?? property?._count?.contacts ?? 0) || 0),
    shares: Math.max(0, Number(property?.sharesCount ?? property?._count?.shares ?? 0) || 0),
  };
}

/** Days since a timestamp; returns +∞ (safe) for a missing/invalid input. */
function daysSince(when: unknown): number {
  if (!when) return Infinity;
  const t = when instanceof Date ? when.getTime() : new Date(when as string | number).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
}

// ---- Component scorers ------------------------------------------------

function scoreCompleteness(property: any): number {
  let s = 0;
  if (looksTruthyString(property?.title ?? property?.listingNumber)) s += 4;
  if (stringLen(property?.description) >= 80) s += 4;
  if (positiveNumber(property?.price ?? property?.priceHalalahs ?? property?.dailyRate ?? property?.grossAmountHalalahs) !== null) s += 4;
  if (looksTruthyString(property?.type ?? property?.category)) s += 3;
  if (looksTruthyString(property?.city)) s += 3;
  if (looksTruthyString(property?.district ?? property?.neighborhood)) s += 3;
  if (positiveNumber(property?.area ?? property?.areaSqm ?? property?.size)) s += 2;
  if (positiveNumber(property?.bedrooms ?? property?.rooms) || positiveNumber(property?.bathrooms ?? property?.bath)) s += 2;
  return clamp(s, CLAMPS.completeness);
}

function scoreMedia(property: any): number {
  const images = readImageCount(property);
  let s = 0;
  if (images >= 1) s += 5;
  if (images >= 5) s += 5;
  if (images >= 10) s += 4;
  if (readVideoFlag(property)) s += 3;
  if (readTourFlag(property)) s += 3;
  return clamp(s, CLAMPS.media);
}

function scoreFreshness(property: any): number {
  const days = daysSince(property?.publishedAt ?? property?.createdAt);
  if (days <= 3) return 15;
  if (days <= 7) return 12;
  if (days <= 14) return 9;
  if (days <= 30) return 6;
  if (days <= 60) return 3;
  return 1;
}

function scoreAdvertiserTrust(property: any): number {
  const hasAny = !!(
    property?.owner || property?.office || property?.advertiserVerification || property?.regaLicenseNumber
  );
  if (!hasAny) return 7; // neutral (5..8 per spec)
  let s = 0;
  if (readVerifiedFlag(property)) s += 7;
  const owner = property?.owner ?? property?.office ?? {};
  const complete = !!(
    (owner?.nameAr || owner?.name) &&
    (owner?.phone || owner?.email) &&
    (owner?.avatarUrl || owner?.bio || owner?.profileComplete)
  );
  if (complete) s += 3;
  if (owner?.phoneVerified || owner?.phoneVerifiedAt) s += 2;
  const hasViolations = !!(
    property?.violationsCount ||
    property?.complaintsCount ||
    property?._count?.complaints
  );
  if (!hasViolations) s += 3;
  return clamp(s, CLAMPS.advertiserTrust);
}

function scorePriceSignal(property: any): number {
  const price = positiveNumber(property?.price ?? property?.priceHalalahs ?? property?.dailyRate ?? property?.grossAmountHalalahs);
  if (price === null) return 9; // neutral (8..10 per spec)
  let s = 5; // valid numeric price
  if (price > 100) s += 3; // not extremely-low / suspicious-zero
  // Generic sanity bounds by listing type — halalahs-friendly but tolerant.
  // We ONLY reward when the value plausibly sits inside a common band; we
  // never penalise legitimate listings that happen to fall outside.
  const purpose = String(property?.purpose ?? property?.listingType ?? '').toLowerCase();
  if (purpose === 'daily') {
    if (price >= 80 && price <= 2500) s += 7;
    else if (price >= 40 && price <= 5000) s += 4;
  } else if (purpose === 'rent' || purpose === 'monthly') {
    if (price >= 6000 && price <= 250000) s += 7;
  } else if (purpose === 'sale') {
    if (price >= 100000 && price <= 20000000) s += 7;
  } else {
    // Unknown purpose — small bonus so the score stays useful.
    s += 3;
  }
  return clamp(s, CLAMPS.priceSignal);
}

function scoreEngagement(property: any): number {
  const c = readEngagementCounters(property);
  const anyCounter = c.views + c.saves + c.contacts + c.shares > 0;
  if (!anyCounter) return 5; // neutral per spec
  // Conservative normalisation — engagement can't dominate ranking. Each
  // counter is capped at a small contribution so a "viral" listing tops
  // out at the section max (10) rather than swinging the whole feed.
  const s =
    Math.min(3, c.saves * 0.6) +
    Math.min(3, c.contacts * 0.8) +
    Math.min(2, c.shares * 0.5) +
    Math.min(2, Math.log10(1 + c.views) * 1.2);
  return clamp(s, CLAMPS.engagement);
}

// ---- Public API -------------------------------------------------------

/**
 * Score a single property. Safe against missing/invalid fields — a bad
 * row returns a low-but-defined score rather than throwing.
 */
export function calculatePropertyQualityScore(property: any): PropertyQualityBreakdown {
  try {
    const completeness = scoreCompleteness(property);
    const media = scoreMedia(property);
    const freshness = scoreFreshness(property);
    const advertiserTrust = scoreAdvertiserTrust(property);
    const priceSignal = scorePriceSignal(property);
    const engagement = scoreEngagement(property);
    const total = clamp(
      completeness + media + freshness + advertiserTrust + priceSignal + engagement,
      100,
    );
    return { total, completeness, media, freshness, advertiserTrust, priceSignal, engagement };
  } catch {
    // Ranker must never break the feed. Return a low neutral score so
    // the broken row falls to the back rather than crashing the request.
    return { total: 20, completeness: 0, media: 0, freshness: 1, advertiserTrust: 7, priceSignal: 7, engagement: 5 };
  }
}
