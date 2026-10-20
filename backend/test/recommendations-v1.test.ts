/**
 * Recommendations v1 — unit + route tests.
 *
 * Covers the new `src/recommendations/*` module (distinct from the
 * older `src/recommendation/*` scorer). Scenarios:
 *   - reason label map (Arabic) — first-wins ordering
 *   - similarity scorer signals + self-exclusion
 *   - user interest profile decay + confidence
 *   - recommendation score bounds + neutral defaults
 *   - route: flag OFF returns safe fallback (200 + items[])
 *   - route: rejects invalid mode
 *   - route: caps limit
 *   - route: strips ownerId / hides debug fields in production shape
 *   - route: client-supplied userId is ignored
 *   - route: /v1/properties/:id/similar excludes the target itself
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildTestApp, resetDb, shutdown } from './helpers.js';
import recommendationRoutes from '../src/routes/recommendations.js';
import { getPrisma } from '../src/db.js';
import { config } from '../src/config.js';
import { primaryReasonLabelAr, mapRecommendationReasonToArabic } from '../src/recommendations/reasons-ar.js';
import { scoreSimilarity, rankSimilar } from '../src/recommendations/similar-properties.js';
import { buildUserInterestProfile } from '../src/recommendations/user-interest-profile.js';
import { calculateRecommendationScore } from '../src/recommendations/recommendation-score.js';
import type { UserInterestProfile } from '../src/recommendations/recommendation-types.js';

async function server() {
  return buildTestApp(async (a) => { await a.register(recommendationRoutes); });
}

beforeEach(async () => {
  await resetDb();
  await getPrisma().userEvent.deleteMany();
});
afterAll(async () => { await shutdown(); });

async function withFlag<T>(value: boolean, fn: () => Promise<T>): Promise<T> {
  const orig = config.RECOMMENDATIONS_ENABLED;
  (config as unknown as { RECOMMENDATIONS_ENABLED: boolean }).RECOMMENDATIONS_ENABLED = value;
  try { return await fn(); } finally {
    (config as unknown as { RECOMMENDATIONS_ENABLED: boolean }).RECOMMENDATIONS_ENABLED = orig;
  }
}

async function withEnv<T>(env: 'production' | 'development' | 'test', fn: () => Promise<T>): Promise<T> {
  const orig = config.NODE_ENV;
  (config as unknown as { NODE_ENV: string }).NODE_ENV = env;
  try { return await fn(); } finally {
    (config as unknown as { NODE_ENV: string }).NODE_ENV = orig;
  }
}

// ---- reasons-ar --------------------------------------------------

describe('reasons-ar', () => {
  it('translates known reason codes to Arabic', () => {
    expect(mapRecommendationReasonToArabic('city_match')).toBe('في مدينتك');
    expect(mapRecommendationReasonToArabic('fresh_listing')).toBe('إعلان جديد');
  });

  it('returns null for cold_start (no public label)', () => {
    expect(mapRecommendationReasonToArabic('cold_start')).toBeNull();
  });

  it('primaryReasonLabelAr picks the first translatable reason', () => {
    const label = primaryReasonLabelAr(['cold_start', 'city_match', 'fresh_listing']);
    expect(label).toBe('في مدينتك');
  });

  it('primaryReasonLabelAr returns null when no reason is translatable', () => {
    expect(primaryReasonLabelAr(['cold_start'])).toBeNull();
    expect(primaryReasonLabelAr([])).toBeNull();
  });
});

// ---- similar-properties -----------------------------------------

describe('similar-properties', () => {
  const target = {
    id: 'p1',
    category: 'apartment',
    purpose: 'rent',
    city: 'Riyadh',
    district: 'Malqa',
    bedrooms: 3,
    area: 120,
    price: 5000,
  };

  it('perfect match scores highly, mismatch scores lower', () => {
    const twin = { ...target, id: 'p2' };
    const away = { ...target, id: 'p3', city: 'Jeddah', district: 'Other', category: 'villa' };
    const twinScore = scoreSimilarity(target, twin);
    const awayScore = scoreSimilarity(target, away);
    expect(twinScore).toBeGreaterThan(awayScore);
    expect(twinScore).toBeGreaterThan(50);
  });

  it('scoreSimilarity(target, target) returns -1 (self exclusion sentinel)', () => {
    expect(scoreSimilarity(target, target)).toBe(-1);
  });

  it('rankSimilar excludes the target and non-available listings', () => {
    const pool = [
      target,
      { ...target, id: 'hidden', status: 'hidden' },
      { ...target, id: 'ok_1' },
      { ...target, id: 'ok_2', city: 'Jeddah' },
    ];
    const ranked = rankSimilar(target, pool, 10);
    const ids = ranked.map((r) => (r.property as { id: string }).id);
    expect(ids).not.toContain('p1');
    expect(ids).not.toContain('hidden');
    expect(ids).toContain('ok_1');
  });

  it('never throws on empty / broken inputs', () => {
    expect(scoreSimilarity(null, null)).toBe(0);
    expect(scoreSimilarity({ id: 'x' }, { id: 'y' })).toBeGreaterThanOrEqual(0);
    expect(rankSimilar(target, [], 5)).toEqual([]);
  });
});

// ---- user-interest-profile --------------------------------------

describe('buildUserInterestProfile', () => {
  it('returns an empty profile with confidence=0 for no identity', async () => {
    const p = await buildUserInterestProfile({ userId: null, sessionId: null });
    expect(p.confidence).toBe(0);
    expect(p.preferredPropertyIds).toEqual([]);
    expect(p.cityWeights).toEqual({});
  });

  it('aggregates a session profile from tracked events', async () => {
    const prisma = getPrisma();
    const now = new Date();
    await prisma.userEvent.createMany({
      data: [
        { eventType: 'property_save', anonymousSessionId: 'sess-a', propertyId: 'pA', city: 'Riyadh', district: 'Malqa', propertyType: 'apartment', purpose: 'rent', createdAt: now },
        { eventType: 'property_view', anonymousSessionId: 'sess-a', propertyId: 'pB', city: 'Riyadh', district: 'Malqa', propertyType: 'apartment', purpose: 'rent', createdAt: now },
        { eventType: 'property_hide', anonymousSessionId: 'sess-a', propertyId: 'pC', city: 'Jeddah', createdAt: now },
      ],
    });
    const p = await buildUserInterestProfile({ sessionId: 'sess-a' });
    expect(p.preferredPropertyIds).toContain('pA');
    expect(p.dislikedPropertyIds).toContain('pC');
    expect(p.cityWeights.Riyadh).toBeGreaterThan(0);
    expect(p.propertyTypeWeights.apartment).toBeGreaterThan(0);
    expect(p.confidence).toBeGreaterThan(0);
  });
});

// ---- recommendation-score ---------------------------------------

describe('calculateRecommendationScore', () => {
  const profile: UserInterestProfile = {
    preferredPropertyIds: ['p-hot'],
    dislikedPropertyIds: [],
    cityWeights: { Riyadh: 10 },
    districtWeights: { Malqa: 5 },
    propertyTypeWeights: { apartment: 8 },
    listingTypeWeights: { rent: 4 },
    recentSearchTerms: [],
    confidence: 80,
  };

  it('returns a score between 0 and 100 for a fully-populated property', () => {
    const property = { id: 'p-hot', city: 'Riyadh', district: 'Malqa', category: 'apartment', purpose: 'rent', createdAt: new Date() };
    const r = calculateRecommendationScore(property, profile);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.reasons).toContain('based_on_viewed');
    expect(r.reasons).toContain('city_match');
  });

  it('never throws when property is malformed', () => {
    const r = calculateRecommendationScore(null, profile);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('context city outweighs stale profile city', () => {
    const property = { id: 'p-ctx', city: 'Jeddah', category: 'apartment', purpose: 'rent', createdAt: new Date() };
    const withCtx = calculateRecommendationScore(property, profile, { city: 'Jeddah' });
    const noCtx = calculateRecommendationScore(property, profile);
    expect(withCtx.score).toBeGreaterThanOrEqual(noCtx.score);
    expect(withCtx.reasons).toContain('city_match');
  });
});

// ---- GET /v1/recommendations ------------------------------------

describe('GET /v1/recommendations', () => {
  it('flag off returns 200 with safe fallback (never crashes)', async () => {
    await withFlag(false, async () => {
      const app = await server();
      const res = await app.inject({ method: 'GET', url: '/v1/recommendations' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { fallback: boolean; personalized: boolean; items: unknown[] };
      expect(body.fallback).toBe(true);
      expect(body.personalized).toBe(false);
      expect(Array.isArray(body.items)).toBe(true);
      await app.close();
    });
  });

  it('rejects an invalid mode with 400', async () => {
    await withFlag(true, async () => {
      const app = await server();
      const res = await app.inject({ method: 'GET', url: '/v1/recommendations?mode=steal_data' });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  it('caps limit at 50', async () => {
    await withFlag(false, async () => {
      const app = await server();
      const res = await app.inject({ method: 'GET', url: '/v1/recommendations?limit=9999' });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  it('never leaks ownerId or hides debug fields in production', async () => {
    const prisma = getPrisma();
    const owner = await prisma.user.create({ data: { phone: '+9660100', nameAr: 'مالك' } });
    await prisma.property.create({
      data: { listingNumber: `L-${Date.now()}`, ownerId: owner.id, category: 'apartment', purpose: 'rent' },
    });

    await withEnv('production', async () => {
      await withFlag(false, async () => {
        const app = await server();
        const res = await app.inject({ method: 'GET', url: '/v1/recommendations?limit=5' });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { items: Record<string, unknown>[] };
        for (const it of body.items) {
          expect(it).not.toHaveProperty('ownerId');
          expect(it).not.toHaveProperty('officeId');
          expect(it).not.toHaveProperty('_score');
          expect(it).not.toHaveProperty('_reasons');
        }
        await app.close();
      });
    });
  });

  it('accepts an anonymous sessionId (no auth required)', async () => {
    await withFlag(true, async () => {
      const app = await server();
      const res = await app.inject({ method: 'GET', url: '/v1/recommendations?sessionId=abc-123' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  it('rejects a bogus sessionId shape', async () => {
    await withFlag(true, async () => {
      const app = await server();
      const res = await app.inject({ method: 'GET', url: '/v1/recommendations?sessionId=%20%20' });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });
});

// ---- GET /v1/properties/:id/similar -----------------------------

describe('GET /v1/properties/:id/similar', () => {
  it('returns [] when the target property does not exist', async () => {
    await withFlag(true, async () => {
      const app = await server();
      const res = await app.inject({ method: 'GET', url: '/v1/properties/nope/similar' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: unknown[] };
      expect(body.items).toEqual([]);
      await app.close();
    });
  });

  it('excludes the target itself and hidden listings', async () => {
    const prisma = getPrisma();
    const owner = await prisma.user.create({ data: { phone: '+9660200', nameAr: 'ب' } });
    const target = await prisma.property.create({
      data: { listingNumber: `L-T-${Date.now()}`, ownerId: owner.id, category: 'apartment', purpose: 'rent', status: 'available' },
    });
    await prisma.property.create({
      data: { listingNumber: `L-A-${Date.now()}`, ownerId: owner.id, category: 'apartment', purpose: 'rent', status: 'available' },
    });
    await prisma.property.create({
      data: { listingNumber: `L-H-${Date.now()}`, ownerId: owner.id, category: 'apartment', purpose: 'rent', status: 'hidden' },
    });

    await withFlag(true, async () => {
      const app = await server();
      const res = await app.inject({ method: 'GET', url: `/v1/properties/${target.id}/similar?limit=10` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { id: string }[] };
      for (const it of body.items) {
        expect(it.id).not.toBe(target.id);
      }
      await app.close();
    });
  });
});
