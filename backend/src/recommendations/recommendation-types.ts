/**
 * Recommendations v1 — public type surface.
 *
 * The scorer + service reads a `UserInterestProfile` that summarises
 * the caller's recent behaviour (from `UserEvent`) and blends it with
 * current-request context (city, price band, etc.) to produce a
 * ranked list of properties + reasons.
 *
 * Zero external services. Deterministic. Same inputs → same outputs.
 */

export const RECOMMENDATION_MODES = [
  'for_you',
  'similar',
  'recently_viewed_related',
  'saved_related',
  'new_for_you',
] as const;

export type RecommendationMode = typeof RECOMMENDATION_MODES[number];

export type RecommendationReason =
  | 'based_on_saved'
  | 'based_on_viewed'
  | 'based_on_contacted'
  | 'city_match'
  | 'district_match'
  | 'property_type_match'
  | 'listing_type_match'
  | 'similar_price'
  | 'fresh_listing'
  | 'high_quality'
  | 'new_for_you'
  | 'popular_now'
  | 'cold_start';

export type RecommendationContext = {
  city?: string;
  district?: string;
  propertyType?: string;
  listingType?: string;
  minPrice?: number;
  maxPrice?: number;
};

export type UserInterestProfile = {
  preferredPropertyIds: string[];
  dislikedPropertyIds: string[];
  cityWeights: Record<string, number>;
  districtWeights: Record<string, number>;
  propertyTypeWeights: Record<string, number>;
  listingTypeWeights: Record<string, number>;
  recentSearchTerms: string[];
  /** 0..100 — how confident we are in the profile. Low = cold start. */
  confidence: number;
};

export type RecommendationItem = {
  property: unknown;      // raw Prisma row (routes strip fields per visibility)
  score: number;          // 0..100
  reasons: RecommendationReason[];
};

export function isValidMode(v: unknown): v is RecommendationMode {
  return typeof v === 'string' && (RECOMMENDATION_MODES as readonly string[]).includes(v);
}
