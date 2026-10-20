/**
 * "اكتمال البيانات" — client-side UI completeness meter.
 *
 * This is INTENTIONALLY NOT the backend's Quality Score. That score
 * is internal and its weights must never leak into user copy. This
 * helper computes a simple "how many recommended fields are filled?"
 * percentage plus a bilingual list of specific suggestions the owner
 * can act on right now.
 *
 * Fields are grouped by category. Each field carries an Arabic hint
 * shown when it's missing. The percentage is filled/total, rounded
 * to the nearest integer.
 */

import type { PropertyRow } from './property-authoring';

type FieldRule = {
  key: keyof PropertyRow;
  hintAr: string;
  present: (row: Partial<PropertyRow>) => boolean;
};

const RULES: FieldRule[] = [
  { key: 'city',         hintAr: 'أضف المدينة',            present: (r) => typeof r.city === 'string' && r.city.trim() !== '' },
  { key: 'district',     hintAr: 'حدّد الحي',              present: (r) => typeof r.district === 'string' && r.district.trim() !== '' },
  { key: 'addressText',  hintAr: 'أضف عنوانًا واضحًا',       present: (r) => typeof r.addressText === 'string' && r.addressText.trim().length >= 8 },
  { key: 'priceHalalahs', hintAr: 'حدّد السعر',            present: (r) => {
      const v = r.priceHalalahs;
      if (v === null || v === undefined) return false;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) && n > 0;
    } },
  { key: 'pricePeriod',  hintAr: 'اختر دورية السعر',        present: (r) => !!r.pricePeriod },
  { key: 'areaSqm',      hintAr: 'أضف المساحة',             present: (r) => typeof r.areaSqm === 'number' && r.areaSqm > 0 },
  { key: 'bedrooms',     hintAr: 'أضف عدد غرف النوم',        present: (r) => typeof r.bedrooms === 'number' && r.bedrooms >= 0 },
  { key: 'bathrooms',    hintAr: 'أضف عدد دورات المياه',     present: (r) => typeof r.bathrooms === 'number' && r.bathrooms >= 0 },
  { key: 'parkingSpaces', hintAr: 'أضف عدد المواقف',         present: (r) => typeof r.parkingSpaces === 'number' && r.parkingSpaces >= 0 },
  { key: 'furnished',    hintAr: 'وضّح إن كان العقار مفروشًا', present: (r) => typeof r.furnished === 'boolean' },
];

export type CompletenessResult = {
  /** 0..100, integer. */
  percent: number;
  /** Arabic hints for fields that are still missing. Empty when 100%. */
  missing: string[];
  filledCount: number;
  totalCount: number;
};

export function computeCompleteness(row: Partial<PropertyRow>): CompletenessResult {
  const filled: string[] = [];
  const missing: string[] = [];
  for (const rule of RULES) {
    if (rule.present(row)) filled.push(String(rule.key));
    else missing.push(rule.hintAr);
  }
  const total = RULES.length;
  const percent = Math.round((filled.length / total) * 100);
  return { percent, missing, filledCount: filled.length, totalCount: total };
}
