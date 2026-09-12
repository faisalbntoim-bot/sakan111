/**
 * Smart feed v1 — unit tests for the pure scorers + diversity pass +
 * one end-to-end assertion against the /v1/properties/feed route so
 * the flag-gated integration is proven to be backward-compatible.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { calculatePropertyQualityScore } from '../src/services/property-quality-score.js';
import { calculateFeedScore } from '../src/services/feed-ranking.js';
import { diversifyFeed } from '../src/services/feed-diversity.js';
import { buildTestApp, resetDb, shutdown } from './helpers.js';
import propertyRoutes from '../src/routes/properties.js';
import { getPrisma } from '../src/db.js';

// ---- Small fixture helpers -----------------------------------------

function completeProperty(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p_complete',
    title: 'شقة عائلية بحي الملقا',
    description: 'شقة عصرية ٣ غرف مع مطبخ مفتوح وموقع قريب من المدارس والحدائق ومسارات المشي الرئيسية شمال الرياض.',
    price: 260,
    category: 'apartment',
    type: 'apartment',
    purpose: 'daily',
    city: 'Riyadh',
    district: 'Malqa',
    area: 180,
    bedrooms: 3,
    bathrooms: 2,
    images: [1,2,3,4,5,6,7,8,9,10],
    videoUrl: 'https://example.com/v.mp4',
    tourUrl: 'https://example.com/tour',
    createdAt: new Date(),
    publishedAt: new Date(),
    owner: { verified: true, phoneVerified: true, nameAr: 'مالك', phone: '+9660', avatarUrl: 'x' },
    regaLicenseNumber: 'RGA-1',
    savesCount: 10, contactsCount: 4, viewsCount: 500, sharesCount: 2,
    ...overrides,
  };
}

function bareProperty(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p_bare',
    createdAt: new Date(),
    ...overrides,
  };
}

// ---- Quality score -------------------------------------------------

describe('property quality score', () => {
  it('gives complete properties a much higher score than bare ones', () => {
    const good = calculatePropertyQualityScore(completeProperty()).total;
    const bad = calculatePropertyQualityScore(bareProperty()).total;
    expect(good).toBeGreaterThan(bad + 30);
  });

  it('freshness monotonically decreases with age', () => {
    const fresh = calculatePropertyQualityScore(completeProperty()).freshness;
    const old60 = calculatePropertyQualityScore(completeProperty({ createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), publishedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })).freshness;
    const old365 = calculatePropertyQualityScore(completeProperty({ createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), publishedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) })).freshness;
    expect(fresh).toBeGreaterThan(old60);
    expect(old60).toBeGreaterThanOrEqual(old365);
  });

  it('never crashes on garbage input; total is always 0..100', () => {
    for (const trash of [null, undefined, {}, 'string', 42, [], { price: 'not-a-number', description: 3 }, { createdAt: 'invalid' }]) {
      const r = calculatePropertyQualityScore(trash as unknown);
      expect(r.total).toBeGreaterThanOrEqual(0);
      expect(r.total).toBeLessThanOrEqual(100);
    }
  });
});

// ---- Feed score ----------------------------------------------------

describe('feed ranking', () => {
  it('city match increases the score', () => {
    const p = completeProperty({ city: 'Riyadh' });
    const noCtx = calculateFeedScore(p).score;
    const withCity = calculateFeedScore(p, { city: 'Riyadh' }).score;
    expect(withCity).toBeGreaterThan(noCtx);
    expect(calculateFeedScore(p, { city: 'Riyadh' }).reasons).toContain('city_match');
  });

  it('district match increases the score', () => {
    const p = completeProperty({ district: 'Malqa' });
    const cityOnly = calculateFeedScore(p, { city: 'Riyadh' }).score;
    const both = calculateFeedScore(p, { city: 'Riyadh', district: 'Malqa' }).score;
    expect(both).toBeGreaterThan(cityOnly);
    expect(calculateFeedScore(p, { city: 'Riyadh', district: 'Malqa' }).reasons).toContain('district_match');
  });

  it('matching price range increases the score', () => {
    const p = completeProperty({ price: 260, purpose: 'daily' });
    const inBand = calculateFeedScore(p, { minPrice: 100, maxPrice: 500 }).score;
    const outBand = calculateFeedScore(p, { minPrice: 1000, maxPrice: 5000 }).score;
    expect(inBand).toBeGreaterThan(outBand);
  });

  it('missing/invalid property fields never crash scoring', () => {
    for (const trash of [null, undefined, {}, {price:'x',createdAt:'nope'}]) {
      const r = calculateFeedScore(trash as unknown, { city: 'X' });
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it('freshness signal reflects listing age (fresh > old)', () => {
    const fresh = calculateFeedScore(completeProperty()).score;
    const old = calculateFeedScore(completeProperty({ createdAt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000), publishedAt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) })).score;
    expect(fresh).toBeGreaterThan(old);
  });
});

// ---- Diversity -----------------------------------------------------

describe('feed diversity', () => {
  it('breaks a run of 4+ same-advertiser listings', () => {
    // 5 from advertiser A followed by 1 from advertiser B — A must not
    // appear 4 times in a row after diversification.
    const items = [
      { ownerId: 'A', score: 5 },
      { ownerId: 'A', score: 4.9 },
      { ownerId: 'A', score: 4.8 },
      { ownerId: 'A', score: 4.7 },
      { ownerId: 'A', score: 4.6 },
      { ownerId: 'B', score: 1 },
    ] as const;
    const out = diversifyFeed([...items]);
    let streak = 1;
    for (let i = 1; i < out.length; i++) {
      const cur = out[i] as { ownerId: string };
      const prev = out[i-1] as { ownerId: string };
      streak = cur.ownerId === prev.ownerId ? streak + 1 : 1;
      expect(streak).toBeLessThanOrEqual(3);
    }
    // Nothing is dropped.
    expect(out.length).toBe(items.length);
  });

  it('is a no-op for lists shorter than the streak limit', () => {
    const items = [{ ownerId: 'A' }, { ownerId: 'A' }, { ownerId: 'A' }];
    expect(diversifyFeed([...items])).toEqual(items);
  });

  it('is deterministic (same input → same output)', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ ownerId: i < 5 ? 'A' : 'B', district: 'D', category: 'apartment', score: 10 - i }));
    const a = diversifyFeed([...items]);
    const b = diversifyFeed([...items]);
    expect(a).toEqual(b);
  });
});

// ---- End-to-end: existing feed stays backward-compatible ----------

async function server() {
  return buildTestApp(async (a) => { await a.register(propertyRoutes); });
}
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

describe('GET /v1/properties/feed — backward compatibility', () => {
  it('returns ranking:"default" when no sort=smart is passed', async () => {
    const prisma = getPrisma();
    const u = await prisma.user.create({ data: { phone: '+9661111', nameAr: 'م' } });
    await prisma.property.createMany({ data: [
      { listingNumber: 'F-1', ownerId: u.id, category: 'apartment', purpose: 'daily' },
      { listingNumber: 'F-2', ownerId: u.id, category: 'apartment', purpose: 'daily' },
    ] });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties/feed' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; ranking: string };
    expect(body.ranking).toBe('default');
    expect(Array.isArray(body.items)).toBe(true);
    await app.close();
  });

  it('sort=smart is IGNORED when SMART_FEED_ENABLED is off (returns default order, no error)', async () => {
    // The test env does not set SMART_FEED_ENABLED, so the flag stays
    // false and the smart branch is bypassed. The user still gets a
    // valid 200 response with the default ranking — no 5xx, no crash.
    const prisma = getPrisma();
    const u = await prisma.user.create({ data: { phone: '+9661112', nameAr: 'م' } });
    await prisma.property.create({ data: { listingNumber: 'F-3', ownerId: u.id, category: 'apartment', purpose: 'daily' } });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties/feed?sort=smart&city=Riyadh' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ranking: string };
    expect(body.ranking).toBe('default');
    await app.close();
  });
});
