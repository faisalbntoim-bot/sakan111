/**
 * Recommendation Engine V1 — deterministic property scorer.
 *
 * Given a user's preference profile + a property, produce a score in 0..100
 * plus a `reasons[]` list so the API and UI can explain WHY a property
 * ranked where it did. Deterministic: same inputs → same output. No ML.
 *
 * Weights sum to 100 and live in one place; tune here.
 */

import type { PreferenceProfile } from './preferences.js';

const W = {
  location: 25,       // city + district match
  price: 20,          // price falls inside preferred band
  propertyType: 15,
  purpose: 10,        // sale / rent / daily
  behaviorSimilarity: 10, // reserved for a future collaborative-filter score
  quality: 10,        // Property Quality Score (0..100)
  freshness: 5,
  performance: 5,     // e.g. save/contact rate — absent for now
} as const;

export type ScorableProperty = {
  id: string;
  category: string | null;
  purpose: string | null;
  city: string | null;
  district: string | null;
  priceHalalahs: bigint | number | null;
  qualityScore: number;    // 0..100 — precomputed via quality.ts
  createdAt: Date;
};

export type ScoreResult = {
  score: number;
  reasons: string[];
};

function fresh(now: Date, createdAt: Date): number {
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays <= 7) return 1;
  if (ageDays >= 90) return 0;
  return 1 - (ageDays - 7) / 83;
}

export function scorePropertyForUser(
  profile: PreferenceProfile,
  p: ScorableProperty,
  now: Date = new Date(),
): ScoreResult {
  const reasons: string[] = [];
  const parts: Array<{ value: number; weight: number }> = [];

  // 1) Location — city top-3 counts full, next two half.
  const cityIdx = p.city ? profile.preferredCities.indexOf(p.city) : -1;
  const distIdx = p.district ? profile.preferredDistricts.indexOf(p.district) : -1;
  let locValue = 0;
  if (cityIdx === 0) { locValue = 1; reasons.push('matches_preferred_city'); }
  else if (cityIdx > 0 && cityIdx <= 2) { locValue = 0.7; reasons.push('matches_top_city'); }
  else if (cityIdx > 2) locValue = 0.4;
  if (distIdx === 0) { locValue = Math.max(locValue, 1); reasons.push('matches_preferred_district'); }
  else if (distIdx > 0) locValue = Math.max(locValue, 0.6);
  parts.push({ value: locValue, weight: W.location });

  // 2) Price band — inside band = 1, edges taper to 0.
  if (p.priceHalalahs !== null && profile.preferredPriceMinHalalahs !== null && profile.preferredPriceMaxHalalahs !== null) {
    const price = typeof p.priceHalalahs === 'bigint' ? Number(p.priceHalalahs) : p.priceHalalahs;
    const min = Number(profile.preferredPriceMinHalalahs);
    const max = Number(profile.preferredPriceMaxHalalahs);
    if (Number.isFinite(price) && max > min) {
      const mid = (min + max) / 2;
      const halfBand = (max - min) / 2;
      const dist = Math.abs(price - mid);
      let priceValue = 0;
      if (dist <= halfBand) { priceValue = 1; reasons.push('matches_price_range'); }
      else if (dist <= halfBand * 2) priceValue = 1 - (dist - halfBand) / halfBand;
      parts.push({ value: Math.max(0, priceValue), weight: W.price });
    }
  }

  // 3) Property type.
  if (p.category && profile.preferredPropertyTypes.length > 0) {
    const idx = profile.preferredPropertyTypes.indexOf(p.category);
    if (idx === 0) { parts.push({ value: 1, weight: W.propertyType }); reasons.push('preferred_property_type'); }
    else if (idx > 0) parts.push({ value: 0.6, weight: W.propertyType });
    else parts.push({ value: 0, weight: W.propertyType });
  }

  // 4) Purpose.
  if (p.purpose && profile.preferredPurposes.length > 0) {
    const idx = profile.preferredPurposes.indexOf(p.purpose);
    if (idx === 0) { parts.push({ value: 1, weight: W.purpose }); reasons.push('preferred_purpose'); }
    else if (idx > 0) parts.push({ value: 0.5, weight: W.purpose });
    else parts.push({ value: 0, weight: W.purpose });
  }

  // 5) Behaviour similarity — placeholder (0 for now). Reserved for a
  //    later phase that compares the property vector to the user's history
  //    of engaged properties (co-view / co-save clusters).
  parts.push({ value: 0, weight: W.behaviorSimilarity });

  // 6) Quality — already 0..100, normalise.
  parts.push({ value: p.qualityScore / 100, weight: W.quality });
  if (p.qualityScore >= 80) reasons.push('high_quality_listing');

  // 7) Freshness.
  parts.push({ value: fresh(now, p.createdAt), weight: W.freshness });

  // 8) Performance placeholder.
  parts.push({ value: 0, weight: W.performance });

  const totalWeight = parts.reduce((s, x) => s + x.weight, 0);
  const raw = parts.reduce((s, x) => s + x.value * x.weight, 0);
  const score = totalWeight > 0 ? (raw / totalWeight) * 100 : 0;
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/**
 * Cold-start scorer for users with no signal yet. Balances quality +
 * freshness + a soft popularity proxy so the feed is not random but
 * also not stuck on one district. `popularity` is 0..1 (e.g. events
 * count normalised).
 */
export function scorePropertyColdStart(
  p: ScorableProperty & { popularity?: number },
  now: Date = new Date(),
): ScoreResult {
  const reasons: string[] = ['cold_start'];
  const parts: Array<{ value: number; weight: number }> = [
    { value: p.qualityScore / 100, weight: 45 },
    { value: fresh(now, p.createdAt), weight: 25 },
    { value: p.popularity ?? 0, weight: 20 },
    { value: p.city ? 1 : 0, weight: 10 }, // any known location beats none
  ];
  if (p.qualityScore >= 80) reasons.push('high_quality_listing');
  const totalWeight = parts.reduce((s, x) => s + x.weight, 0);
  const raw = parts.reduce((s, x) => s + x.value * x.weight, 0);
  const score = (raw / totalWeight) * 100;
  return { score: Math.max(0, Math.min(100, score)), reasons };
}
