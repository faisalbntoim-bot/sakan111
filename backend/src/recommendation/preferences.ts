/**
 * User preference profile — derived deterministically from UserEvent rows.
 *
 * We never ask the user for preferences up front. Instead we watch what
 * they view / save / contact / book and infer a preference profile with
 * time decay so recent behaviour outweighs stale behaviour.
 *
 * Decay: each event's raw weight is multiplied by
 *   halfLife^(-ageDays / HALF_LIFE_DAYS)
 * so an event from 30 days ago counts a bit under half as much as a
 * fresh event. This is deterministic — same inputs, same output.
 */

import { EVENT_WEIGHTS, type EventType } from './events.js';

const HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Row shape read from the DB (avoids depending on Prisma types here). */
export type EventRow = {
  eventType: string;
  city: string | null;
  district: string | null;
  propertyType: string | null;
  purpose: string | null;
  priceHalalahs: bigint | number | null;
  createdAt: Date;
};

export type PreferenceProfile = {
  hasSignal: boolean;
  preferredCities: string[];      // sorted, most-preferred first
  preferredDistricts: string[];
  preferredPropertyTypes: string[];
  preferredPurposes: string[];
  preferredPriceMinHalalahs: bigint | null;
  preferredPriceMaxHalalahs: bigint | null;
};

function decayedWeight(eventType: string, createdAt: Date, now: Date): number {
  const base = (EVENT_WEIGHTS as Record<string, number>)[eventType];
  if (typeof base !== 'number' || base === 0) return 0;
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / MS_PER_DAY);
  // Half-life decay: weight halves every HALF_LIFE_DAYS.
  const decay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  return base * decay;
}

function topKeys(counter: Map<string, number>, limit = 5): string[] {
  return [...counter.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

/**
 * Aggregate an event stream into a preference profile.
 * `now` is injectable so tests are deterministic.
 */
export function buildPreferenceProfile(events: EventRow[], now: Date = new Date()): PreferenceProfile {
  const cityWeights = new Map<string, number>();
  const districtWeights = new Map<string, number>();
  const typeWeights = new Map<string, number>();
  const purposeWeights = new Map<string, number>();
  let priceSum = 0;
  let priceWeightSum = 0;
  let hasSignal = false;

  for (const e of events) {
    const w = decayedWeight(e.eventType, e.createdAt, now);
    if (w === 0) continue;
    hasSignal = true;
    if (e.city) cityWeights.set(e.city, (cityWeights.get(e.city) ?? 0) + w);
    if (e.district) districtWeights.set(e.district, (districtWeights.get(e.district) ?? 0) + w);
    if (e.propertyType) typeWeights.set(e.propertyType, (typeWeights.get(e.propertyType) ?? 0) + w);
    if (e.purpose) purposeWeights.set(e.purpose, (purposeWeights.get(e.purpose) ?? 0) + w);
    if (e.priceHalalahs !== null && w > 0) {
      const priceNum = typeof e.priceHalalahs === 'bigint' ? Number(e.priceHalalahs) : e.priceHalalahs;
      if (Number.isFinite(priceNum) && priceNum > 0) {
        priceSum += priceNum * w;
        priceWeightSum += w;
      }
    }
  }

  const avgPrice = priceWeightSum > 0 ? priceSum / priceWeightSum : 0;
  // Prefer ±35% around the weighted-average price the user actually engaged with.
  const priceMin = avgPrice > 0 ? BigInt(Math.floor(avgPrice * 0.65)) : null;
  const priceMax = avgPrice > 0 ? BigInt(Math.ceil(avgPrice * 1.35)) : null;

  return {
    hasSignal,
    preferredCities: topKeys(cityWeights),
    preferredDistricts: topKeys(districtWeights),
    preferredPropertyTypes: topKeys(typeWeights),
    preferredPurposes: topKeys(purposeWeights),
    preferredPriceMinHalalahs: priceMin,
    preferredPriceMaxHalalahs: priceMax,
  };
}
