/**
 * Arabic labels for recommendation reason codes.
 *
 * Public UI should surface at most one Arabic phrase — the top reason.
 * Raw reason codes never appear in the payload in production; this map
 * is the ONLY sanctioned translation. Missing keys return null so the
 * caller can hide the badge rather than show a technical string.
 */

import type { RecommendationReason } from './recommendation-types.js';

const AR: Partial<Record<RecommendationReason, string>> = {
  based_on_saved:      'مشابه لعقارات حفظتها',
  based_on_viewed:     'بناءً على ما شاهدته',
  based_on_contacted:  'قريب من عقارات تواصلت معها',
  city_match:          'في مدينتك',
  district_match:      'في حي تهتم به',
  property_type_match: 'نوع العقار الذي تفضّله',
  listing_type_match:  'مطابق لبحثك',
  similar_price:       'ضمن نطاق سعرك',
  fresh_listing:       'إعلان جديد',
  high_quality:        'إعلان مكتمل الجودة',
  new_for_you:         'جديد قد يهمّك',
  popular_now:         'رائج الآن',
};

export function mapRecommendationReasonToArabic(reason: RecommendationReason): string | null {
  return AR[reason] ?? null;
}

/** Pick a single best label for a list of reasons. First-wins order. */
export function primaryReasonLabelAr(reasons: readonly RecommendationReason[]): string | null {
  for (const r of reasons) {
    const label = mapRecommendationReasonToArabic(r);
    if (label) return label;
  }
  return null;
}
