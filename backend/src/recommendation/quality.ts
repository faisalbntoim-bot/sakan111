/**
 * Property Quality Score (0..100).
 *
 * Signals that raise or lower a listing's rank independently of any user's
 * preferences. The goal: incomplete/dodgy listings should not dominate
 * search results even if a user's preference profile matches them.
 *
 * Only signals present in the current Property schema (or trivially
 * derivable from it) are used. Missing signals are treated as neutral
 * (weight redistributed) so we do not penalise legitimate listings that
 * lack an optional field.
 */

const WEIGHTS = {
  informationCompleteness: 25,
  mediaQuality: 20,
  verification: 20,
  hostQuality: 15,
  freshness: 10,
  performance: 10,
} as const;

/** Inputs are already-loaded scalars — no DB lookups inside the scorer. */
export type QualityInputs = {
  hasCategory: boolean;
  hasPurpose: boolean;
  hasListingNumber: boolean;
  imageCount: number;             // 0 if unknown
  advertisementLifecycle: string; // DRAFT | SUBMITTED | VERIFIED | PUBLISHED | EXPIRED | ...
  hasRegaLicense: boolean;
  hostReviewsCount?: number;      // optional — pass through if you have it
  hostAverageRating?: number;     // 0..5
  createdAt: Date;
  now?: Date;                     // injectable for tests
};

export function computeQualityScore(input: QualityInputs): number {
  const now = input.now ?? new Date();
  const parts: Array<{ value: number; weight: number }> = [];

  // 1) Information completeness — required fields present.
  const completenessFields = [input.hasCategory, input.hasPurpose, input.hasListingNumber];
  const completenessFilled = completenessFields.filter(Boolean).length / completenessFields.length;
  parts.push({ value: completenessFilled, weight: WEIGHTS.informationCompleteness });

  // 2) Media — 5+ photos is "full", 0 photos is 0.
  const mediaValue = Math.min(1, input.imageCount / 5);
  parts.push({ value: mediaValue, weight: WEIGHTS.mediaQuality });

  // 3) Verification — REGA lifecycle.
  const lifecycle = input.advertisementLifecycle;
  let verifValue = 0;
  if (lifecycle === 'PUBLISHED') verifValue = 1;
  else if (lifecycle === 'VERIFIED') verifValue = 0.8;
  else if (lifecycle === 'SUBMITTED') verifValue = 0.4;
  else if (lifecycle === 'EXPIRED' || lifecycle === 'SUSPENDED' || lifecycle === 'REMOVED') verifValue = 0;
  else verifValue = 0.2;
  if (input.hasRegaLicense) verifValue = Math.min(1, verifValue + 0.1);
  parts.push({ value: verifValue, weight: WEIGHTS.verification });

  // 4) Host quality — average rating scaled to 0..1. Absent = neutral.
  if (typeof input.hostAverageRating === 'number' && Number.isFinite(input.hostAverageRating)) {
    const rating = Math.max(0, Math.min(5, input.hostAverageRating));
    parts.push({ value: rating / 5, weight: WEIGHTS.hostQuality });
  }

  // 5) Freshness — listing < 30 days old is fully fresh; > 180 days = 0.
  const ageDays = Math.max(0, (now.getTime() - input.createdAt.getTime()) / (24 * 60 * 60 * 1000));
  let freshValue: number;
  if (ageDays <= 30) freshValue = 1;
  else if (ageDays >= 180) freshValue = 0;
  else freshValue = 1 - (ageDays - 30) / 150;
  parts.push({ value: freshValue, weight: WEIGHTS.freshness });

  // 6) Performance — reviews count (if we have it). Absent = neutral.
  if (typeof input.hostReviewsCount === 'number' && input.hostReviewsCount > 0) {
    parts.push({ value: Math.min(1, input.hostReviewsCount / 10), weight: WEIGHTS.performance });
  }

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  if (totalWeight === 0) return 50;
  const raw = parts.reduce((s, p) => s + p.value * p.weight, 0);
  const score = (raw / totalWeight) * 100;
  return Math.max(0, Math.min(100, score));
}
