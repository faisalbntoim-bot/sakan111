/**
 * Recommendation Engine V1 — unit tests.
 *
 * These are pure-function tests: no DB, no Fastify server. They cover
 * the pieces the routes glue together — event weights + metadata
 * sanitisation, preference profile aggregation with decay, property
 * quality scoring, and the personalised + cold-start scorers.
 */

import { describe, it, expect } from 'vitest';
import { EVENT_TYPES, EVENT_WEIGHTS, isEventType, sanitizeMetadata } from '../src/recommendation/events.js';
import { buildPreferenceProfile, type EventRow } from '../src/recommendation/preferences.js';
import { computeQualityScore } from '../src/recommendation/quality.js';
import { scorePropertyForUser, scorePropertyColdStart, type ScorableProperty } from '../src/recommendation/scorer.js';
import {
  growthRate,
  isEnoughSamples,
  periodBounds,
  periodMs,
  classifyPriceOpportunity,
  decayedEventWeight,
} from '../src/recommendation/market.js';

describe('events / weights whitelist', () => {
  it('lists all expected event types', () => {
    expect(EVENT_TYPES).toContain('PROPERTY_VIEW');
    expect(EVENT_TYPES).toContain('BOOKING_COMPLETE');
    expect(EVENT_TYPES).toContain('PROPERTY_HIDE');
  });

  it('booking_complete outweighs a raw view many times over', () => {
    expect(EVENT_WEIGHTS.BOOKING_COMPLETE).toBeGreaterThan(EVENT_WEIGHTS.PROPERTY_VIEW * 10);
  });

  it('property_hide is a strong negative signal', () => {
    expect(EVENT_WEIGHTS.PROPERTY_HIDE).toBeLessThan(0);
  });

  it('isEventType accepts known types and rejects everything else', () => {
    expect(isEventType('PROPERTY_VIEW')).toBe(true);
    expect(isEventType('DELETE_USER')).toBe(false);
    expect(isEventType(42)).toBe(false);
  });
});

describe('metadata sanitisation (privacy)', () => {
  it('drops non-whitelisted keys', () => {
    const out = sanitizeMetadata({ searchTerm: 'villa', password: 'p@ss', creditCard: '4111', source: 'feed' });
    expect(out.searchTerm).toBe('villa');
    expect(out.source).toBe('feed');
    expect(out).not.toHaveProperty('password');
    expect(out).not.toHaveProperty('creditCard');
  });

  it('truncates long strings', () => {
    const long = 'x'.repeat(500);
    const out = sanitizeMetadata({ searchTerm: long });
    expect(typeof out.searchTerm).toBe('string');
    expect((out.searchTerm as string).length).toBe(200);
  });

  it('drops nested objects/arrays inside filters', () => {
    const out = sanitizeMetadata({ filters: { city: 'Riyadh', budget: 30000, nested: { evil: true }, list: [1, 2, 3] } });
    const filters = out.filters as Record<string, unknown>;
    expect(filters.city).toBe('Riyadh');
    expect(filters.budget).toBe(30000);
    expect(filters).not.toHaveProperty('nested');
    expect(filters).not.toHaveProperty('list');
  });

  it('returns {} for non-objects', () => {
    expect(sanitizeMetadata(null)).toEqual({});
    expect(sanitizeMetadata('not-an-object')).toEqual({});
  });
});

describe('preference profile (decay + aggregation)', () => {
  const now = new Date('2026-09-10T00:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  it('returns hasSignal=false when there are no signal-bearing events', () => {
    const profile = buildPreferenceProfile([], now);
    expect(profile.hasSignal).toBe(false);
    expect(profile.preferredCities).toEqual([]);
  });

  it('recent BOOKING_COMPLETE beats a lot of old PROPERTY_VIEW', () => {
    const events: EventRow[] = [
      // 20 old views for city B (30d ago = ~half weight)
      ...Array.from({ length: 20 }, (): EventRow => ({
        eventType: 'PROPERTY_VIEW', city: 'B', district: null, propertyType: null, purpose: null, priceHalalahs: null, createdAt: daysAgo(30),
      })),
      // 1 fresh booking-complete for city A
      { eventType: 'BOOKING_COMPLETE', city: 'A', district: null, propertyType: null, purpose: null, priceHalalahs: null, createdAt: daysAgo(0) },
    ];
    const profile = buildPreferenceProfile(events, now);
    expect(profile.hasSignal).toBe(true);
    expect(profile.preferredCities[0]).toBe('A');
  });

  it('ignores IMPRESSION (weight 0)', () => {
    const events: EventRow[] = Array.from({ length: 100 }, (): EventRow => ({
      eventType: 'PROPERTY_IMPRESSION', city: 'Ghost', district: null, propertyType: null, purpose: null, priceHalalahs: null, createdAt: now,
    }));
    const profile = buildPreferenceProfile(events, now);
    expect(profile.hasSignal).toBe(false);
  });

  it('derives a ±35% price band around engaged prices', () => {
    const events: EventRow[] = Array.from({ length: 5 }, (_, i): EventRow => ({
      eventType: 'PROPERTY_SAVE', city: 'A', district: null, propertyType: null, purpose: null,
      priceHalalahs: BigInt(1_000_000 + i * 100),
      createdAt: now,
    }));
    const profile = buildPreferenceProfile(events, now);
    expect(profile.preferredPriceMinHalalahs).not.toBeNull();
    expect(profile.preferredPriceMaxHalalahs).not.toBeNull();
    const min = Number(profile.preferredPriceMinHalalahs);
    const max = Number(profile.preferredPriceMaxHalalahs);
    expect(min).toBeGreaterThan(600_000);
    expect(max).toBeLessThan(1_500_000);
  });
});

describe('property quality score', () => {
  const base = {
    hasCategory: true,
    hasPurpose: true,
    hasListingNumber: true,
    imageCount: 5,
    advertisementLifecycle: 'PUBLISHED',
    hasRegaLicense: true,
    createdAt: new Date(),
    now: new Date(),
  };

  it('a fully populated PUBLISHED listing scores > 80', () => {
    expect(computeQualityScore(base)).toBeGreaterThan(80);
  });

  it('a bare DRAFT listing scores lower than a fully populated one', () => {
    const good = computeQualityScore(base);
    const bad  = computeQualityScore({ ...base, imageCount: 0, advertisementLifecycle: 'DRAFT', hasRegaLicense: false });
    expect(bad).toBeLessThan(good);
    expect(good - bad).toBeGreaterThan(20);
  });

  it('SUSPENDED sets verification to 0 (not neutral)', () => {
    const a = computeQualityScore(base);
    const b = computeQualityScore({ ...base, advertisementLifecycle: 'SUSPENDED', hasRegaLicense: false });
    expect(b).toBeLessThan(a);
  });

  it('age > 180d reaches freshness=0', () => {
    const old = new Date(base.now.getTime() - 200 * 24 * 60 * 60 * 1000);
    const a = computeQualityScore(base);
    const b = computeQualityScore({ ...base, createdAt: old });
    expect(b).toBeLessThan(a);
  });
});

describe('personalised scorer + reasons', () => {
  const now = new Date('2026-09-10T00:00:00Z');
  const profile = {
    hasSignal: true,
    preferredCities: ['Riyadh'],
    preferredDistricts: ['Malqa'],
    preferredPropertyTypes: ['apartment'],
    preferredPurposes: ['rent'],
    preferredPriceMinHalalahs: BigInt(20_000_00), // 20,000 SAR in halalahs
    preferredPriceMaxHalalahs: BigInt(40_000_00),
  };
  const perfect: ScorableProperty = {
    id: 'p1',
    category: 'apartment',
    purpose: 'rent',
    city: 'Riyadh',
    district: 'Malqa',
    priceHalalahs: BigInt(30_000_00),
    qualityScore: 90,
    createdAt: now,
  };

  it('perfect match yields high score with reasons', () => {
    const r = scorePropertyForUser(profile, perfect, now);
    expect(r.score).toBeGreaterThan(60);
    expect(r.reasons).toContain('matches_preferred_city');
    expect(r.reasons).toContain('matches_preferred_district');
    expect(r.reasons).toContain('matches_price_range');
    expect(r.reasons).toContain('preferred_property_type');
    expect(r.reasons).toContain('preferred_purpose');
  });

  it('mismatched location scores lower than a match', () => {
    const away = { ...perfect, city: 'Jeddah', district: 'Other' };
    const a = scorePropertyForUser(profile, perfect, now).score;
    const b = scorePropertyForUser(profile, away, now).score;
    expect(b).toBeLessThan(a);
  });

  it('cold-start uses quality + freshness, not preferences', () => {
    const r = scorePropertyColdStart({ ...perfect, popularity: 0.4 }, now);
    expect(r.reasons).toContain('cold_start');
    expect(r.score).toBeGreaterThan(30);
  });
});

describe('market pulse helpers', () => {
  it('growthRate returns null when previous is 0', () => {
    expect(growthRate(10, 0)).toBeNull();
    expect(growthRate(0, 0)).toBeNull();
  });

  it('growthRate returns positive percent for growth', () => {
    expect(growthRate(120, 100)).toBe(20);
  });

  it('isEnoughSamples respects the minimum', () => {
    expect(isEnoughSamples(30, 30)).toBe(true);
    expect(isEnoughSamples(29, 30)).toBe(false);
  });

  it('periodBounds yields two equal-length adjacent windows', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const b = periodBounds('7d', now);
    expect(b.currentEnd.getTime()).toBe(now.getTime());
    expect(b.currentStart.getTime()).toBe(now.getTime() - periodMs('7d'));
    expect(b.previousEnd.getTime()).toBe(b.currentStart.getTime());
    expect(b.previousStart.getTime()).toBe(b.currentStart.getTime() - periodMs('7d'));
  });

  it('decayedEventWeight halves at half-life', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const halfLifeMs = 7 * 24 * 60 * 60 * 1000;
    const halfLifeAgo = new Date(now.getTime() - halfLifeMs);
    const fresh = decayedEventWeight('PROPERTY_SAVE', now, now, halfLifeMs);
    const old = decayedEventWeight('PROPERTY_SAVE', halfLifeAgo, now, halfLifeMs);
    expect(old).toBeCloseTo(fresh / 2, 3);
  });

  it('classifyPriceOpportunity requires min sample size', () => {
    const noise = [100_000, 105_000, 95_000];
    const r = classifyPriceOpportunity(100_000, noise, 30);
    expect(r.status).toBe('insufficient_data');
  });

  it('classifyPriceOpportunity labels below/at/above around median band', () => {
    const comps = Array.from({ length: 50 }, (_, i) => 1_000_000 + i * 10_000);
    const below = classifyPriceOpportunity(800_000, comps, 30);
    const at = classifyPriceOpportunity(1_200_000, comps, 30);
    const above = classifyPriceOpportunity(2_000_000, comps, 30);
    expect(below.status === 'ok' && below.label === 'below_market').toBe(true);
    expect(at.status === 'ok' && at.label === 'at_market').toBe(true);
    expect(above.status === 'ok' && above.label === 'above_market').toBe(true);
  });
});
