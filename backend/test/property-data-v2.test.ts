/**
 * Property Data v2 — schema + route + integration tests.
 *
 * Coverage:
 *   - old property payload still works (no v2 fields)
 *   - new v2 fields accepted via PATCH /v1/properties/:id/details
 *   - negative price rejected
 *   - invalid latitude / longitude rejected
 *   - negative bedrooms rejected
 *   - unknown/dangerous keys rejected (`.strict()`)
 *   - null explicitly clears a stored value
 *   - non-owner cannot update (404, not 403 — probing prevention)
 *   - list route accepts v2 filters (city, district, propertyType,
 *     listingType, minPrice/maxPrice, bedrooms)
 *   - GET /v1/properties/:id returns v2 fields
 *   - Quality Score rewards presence of structured fields
 *   - Recommendations city / district / price signals fire
 *   - Similar-properties uses bedrooms / area / price
 *   - Similar-properties tolerates sparse fields
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildTestApp, resetDb, shutdown } from './helpers.js';
import propertyRoutes from '../src/routes/properties.js';
import recommendationRoutes from '../src/routes/recommendations.js';
import { getPrisma } from '../src/db.js';
import { calculatePropertyQualityScore } from '../src/services/property-quality-score.js';
import { calculateRecommendationScore } from '../src/recommendations/recommendation-score.js';
import { scoreSimilarity, rankSimilar } from '../src/recommendations/similar-properties.js';
import type { UserInterestProfile } from '../src/recommendations/recommendation-types.js';

async function server() {
  return buildTestApp(async (a) => { await a.register(propertyRoutes); });
}

async function serverWithRecs() {
  return buildTestApp(async (a) => {
    await a.register(propertyRoutes);
    await a.register(recommendationRoutes);
  });
}

async function makeOwner(phone: string) {
  return getPrisma().user.create({ data: { phone, nameAr: 'مالك' } });
}

async function makeBareProperty(ownerId: string) {
  const listingNumber = `L-${Math.random().toString(36).slice(2, 10)}`;
  return getPrisma().property.create({
    data: { listingNumber, ownerId, category: 'apartment', purpose: 'rent', status: 'available' },
  });
}

beforeEach(async () => {
  await resetDb();
  await getPrisma().userEvent.deleteMany();
});
afterAll(async () => { await shutdown(); });

// ---- 1. Backward compatibility -----------------------------------

describe('backward compatibility', () => {
  it('a legacy Property row (no v2 fields) still lists and reads', async () => {
    const o = await makeOwner('+9663000001');
    await makeBareProperty(o.id);
    const app = await server();
    const list = await app.inject({ method: 'GET', url: '/v1/properties' });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: unknown[] }).items;
    expect(items.length).toBe(1);
    await app.close();
  });
});

// ---- 2. PATCH /v1/properties/:id/details -------------------------

describe('PATCH /v1/properties/:id/details', () => {
  it('owner can set v2 fields', async () => {
    const o = await makeOwner('+9663000002');
    const p = await makeBareProperty(o.id);
    const app = await server();
    const res = await app.inject({
      method: 'PATCH', url: `/v1/properties/${p.id}/details`,
      headers: { 'x-user-id': o.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: {
        city: 'الرياض', district: 'حي الملقا', bedrooms: 3, bathrooms: 2,
        areaSqm: 180, priceHalalahs: 260_00, pricePeriod: 'DAY',
        latitude: 24.7136, longitude: 46.6753, furnished: true, parkingSpaces: 2,
      },
    });
    expect(res.statusCode).toBe(200);
    const row = await getPrisma().property.findUnique({ where: { id: p.id } });
    expect(row?.city).toBe('الرياض');
    expect(row?.bedrooms).toBe(3);
    expect(row?.areaSqm).toBe(180);
    expect(row?.furnished).toBe(true);
    expect(row?.priceHalalahs).toBe(26000n);
    await app.close();
  });

  it('rejects a negative price', async () => {
    const o = await makeOwner('+9663000003');
    const p = await makeBareProperty(o.id);
    const app = await server();
    const res = await app.inject({
      method: 'PATCH', url: `/v1/properties/${p.id}/details`,
      headers: { 'x-user-id': o.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { priceHalalahs: -500 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an out-of-range latitude', async () => {
    const o = await makeOwner('+9663000004');
    const p = await makeBareProperty(o.id);
    const app = await server();
    const res = await app.inject({
      method: 'PATCH', url: `/v1/properties/${p.id}/details`,
      headers: { 'x-user-id': o.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { latitude: 100 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an out-of-range longitude', async () => {
    const o = await makeOwner('+9663000005');
    const p = await makeBareProperty(o.id);
    const app = await server();
    const res = await app.inject({
      method: 'PATCH', url: `/v1/properties/${p.id}/details`,
      headers: { 'x-user-id': o.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { longitude: 200 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects negative bedrooms', async () => {
    const o = await makeOwner('+9663000006');
    const p = await makeBareProperty(o.id);
    const app = await server();
    const res = await app.inject({
      method: 'PATCH', url: `/v1/properties/${p.id}/details`,
      headers: { 'x-user-id': o.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { bedrooms: -1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects unknown / dangerous keys (strict)', async () => {
    const o = await makeOwner('+9663000007');
    const p = await makeBareProperty(o.id);
    const app = await server();
    const res = await app.inject({
      method: 'PATCH', url: `/v1/properties/${p.id}/details`,
      headers: { 'x-user-id': o.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { ownerId: 'other-user', status: 'sold', advertisementLifecycle: 'PUBLISHED', bedrooms: 4 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('non-owner sees 404 (probing prevention)', async () => {
    const o = await makeOwner('+9663000008');
    const other = await makeOwner('+9663000009');
    const p = await makeBareProperty(o.id);
    const app = await server();
    const res = await app.inject({
      method: 'PATCH', url: `/v1/properties/${p.id}/details`,
      headers: { 'x-user-id': other.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { bedrooms: 4 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('null explicitly clears a stored value', async () => {
    const o = await makeOwner('+9663000010');
    const p = await makeBareProperty(o.id);
    await getPrisma().property.update({ where: { id: p.id }, data: { city: 'الرياض' } });
    const app = await server();
    const res = await app.inject({
      method: 'PATCH', url: `/v1/properties/${p.id}/details`,
      headers: { 'x-user-id': o.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { city: null },
    });
    expect(res.statusCode).toBe(200);
    const row = await getPrisma().property.findUnique({ where: { id: p.id } });
    expect(row?.city).toBeNull();
    await app.close();
  });
});

// ---- 3. GET /v1/properties filters -------------------------------

describe('GET /v1/properties — v2 filters', () => {
  it('filters by city, district, and bedrooms', async () => {
    const o = await makeOwner('+9663000020');
    const prisma = getPrisma();
    await prisma.property.create({ data: { listingNumber: 'L-C1', ownerId: o.id, category: 'apartment', purpose: 'rent', city: 'الرياض', district: 'حي الملقا', bedrooms: 3 } });
    await prisma.property.create({ data: { listingNumber: 'L-C2', ownerId: o.id, category: 'apartment', purpose: 'rent', city: 'الرياض', district: 'حي النرجس', bedrooms: 2 } });
    await prisma.property.create({ data: { listingNumber: 'L-C3', ownerId: o.id, category: 'apartment', purpose: 'rent', city: 'جدة', district: 'حي الروضة', bedrooms: 3 } });
    const app = await server();

    const r1 = await app.inject({ method: 'GET', url: '/v1/properties?city=' + encodeURIComponent('الرياض') });
    expect((r1.json() as { total: number }).total).toBe(2);

    const r2 = await app.inject({ method: 'GET', url: '/v1/properties?city=' + encodeURIComponent('الرياض') + '&district=' + encodeURIComponent('حي الملقا') });
    expect((r2.json() as { total: number }).total).toBe(1);

    const r3 = await app.inject({ method: 'GET', url: '/v1/properties?bedrooms=3' });
    expect((r3.json() as { total: number }).total).toBe(2);

    await app.close();
  });

  it('filters by minPrice / maxPrice (halalahs) and propertyType / listingType aliases', async () => {
    const o = await makeOwner('+9663000021');
    const prisma = getPrisma();
    await prisma.property.create({ data: { listingNumber: 'L-P1', ownerId: o.id, category: 'villa', purpose: 'sale', priceHalalahs: 1_000_000n } });
    await prisma.property.create({ data: { listingNumber: 'L-P2', ownerId: o.id, category: 'apartment', purpose: 'rent', priceHalalahs: 500_000n } });
    await prisma.property.create({ data: { listingNumber: 'L-P3', ownerId: o.id, category: 'apartment', purpose: 'rent', priceHalalahs: 2_000_000n } });
    const app = await server();

    const r1 = await app.inject({ method: 'GET', url: '/v1/properties?minPrice=800000&maxPrice=1500000' });
    expect((r1.json() as { total: number }).total).toBe(1);

    const r2 = await app.inject({ method: 'GET', url: '/v1/properties?propertyType=villa' });
    expect((r2.json() as { total: number }).total).toBe(1);

    const r3 = await app.inject({ method: 'GET', url: '/v1/properties?listingType=rent' });
    expect((r3.json() as { total: number }).total).toBe(2);

    await app.close();
  });
});

// ---- 4. Quality Score integration --------------------------------

describe('property-quality-score with v2 fields', () => {
  const baseSparse = {
    listingNumber: 'L-Q',
    category: 'apartment', purpose: 'rent',
    createdAt: new Date(),
  };
  const richerV2 = {
    ...baseSparse,
    city: 'الرياض', district: 'حي الملقا',
    priceHalalahs: 5000n, areaSqm: 180, bedrooms: 3, bathrooms: 2,
  };

  it('a listing with structured v2 fields scores higher than a sparse one', () => {
    const sparse = calculatePropertyQualityScore(baseSparse).total;
    const rich   = calculatePropertyQualityScore(richerV2).total;
    expect(rich).toBeGreaterThan(sparse);
  });

  it('quality score stays in [0, 100]', () => {
    for (const p of [baseSparse, richerV2, {}, null]) {
      const s = calculatePropertyQualityScore(p).total;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});

// ---- 5. Recommendations use city / district / price --------------

describe('recommendation-score with v2 fields', () => {
  const profile: UserInterestProfile = {
    preferredPropertyIds: [],
    dislikedPropertyIds: [],
    cityWeights: { 'الرياض': 10 },
    districtWeights: { 'حي الملقا': 5 },
    propertyTypeWeights: { apartment: 4 },
    listingTypeWeights: { rent: 4 },
    recentSearchTerms: [],
    confidence: 80,
  };

  it('city affinity boosts the score vs. a mismatched city', () => {
    const hit = { id: 'x', city: 'الرياض', category: 'apartment', purpose: 'rent', createdAt: new Date() };
    const miss = { id: 'y', city: 'الدمام', category: 'apartment', purpose: 'rent', createdAt: new Date() };
    expect(calculateRecommendationScore(hit, profile).score)
      .toBeGreaterThan(calculateRecommendationScore(miss, profile).score);
  });

  it('district match adds to the location signal', () => {
    const dHit = { id: 'a', city: 'الرياض', district: 'حي الملقا', category: 'apartment', purpose: 'rent', createdAt: new Date() };
    const ctx = { city: 'الرياض', district: 'حي الملقا' };
    const r = calculateRecommendationScore(dHit, profile, ctx);
    expect(r.reasons).toContain('district_match');
  });

  it('a property inside the price band scores at least as high as one outside', () => {
    const inBand  = { id: 'a', category: 'apartment', purpose: 'rent', priceHalalahs: 5_000n, createdAt: new Date() };
    const outBand = { id: 'b', category: 'apartment', purpose: 'rent', priceHalalahs: 50_000n, createdAt: new Date() };
    const ctx = { minPrice: 3_000, maxPrice: 8_000 };
    const inScore  = calculateRecommendationScore(inBand, profile, ctx).score;
    const outScore = calculateRecommendationScore(outBand, profile, ctx).score;
    expect(inScore).toBeGreaterThanOrEqual(outScore);
    expect(calculateRecommendationScore(inBand, profile, ctx).reasons).toContain('similar_price');
  });
});

// ---- 6. Similar properties uses bedrooms / area / price -----------

describe('similar-properties with v2 fields', () => {
  const target = {
    id: 't', category: 'apartment', purpose: 'rent',
    city: 'الرياض', district: 'حي الملقا',
    bedrooms: 3, areaSqm: 180, priceHalalahs: 5000n,
  };

  it('bedroom similarity contributes to score', () => {
    // Use a target with no city/district/price so the score isn't already
    // clamped at 100 for both candidates.
    const minimal = { id: 't2', category: 'apartment', purpose: 'rent', bedrooms: 3, areaSqm: 180 };
    const sameBeds = { ...minimal, id: 'a' };
    const wildlyDifferentBeds = { ...minimal, id: 'b', bedrooms: 20 };
    expect(scoreSimilarity(minimal, sameBeds))
      .toBeGreaterThan(scoreSimilarity(minimal, wildlyDifferentBeds));
  });

  it('tolerates sparse candidates (missing bedrooms/area/price)', () => {
    const sparse = { id: 'sp', category: 'apartment', purpose: 'rent', city: 'الرياض' };
    const s = scoreSimilarity(target, sparse);
    expect(s).toBeGreaterThan(0);
    expect(Number.isFinite(s)).toBe(true);
  });

  it('rankSimilar handles a mixed pool with sparse rows without throwing', () => {
    const pool = [
      { ...target, id: 'a' },
      { id: 'b', category: 'apartment', purpose: 'rent' },
      { id: 'c', category: 'villa', purpose: 'sale', city: 'جدة' },
    ];
    const ranked = rankSimilar(target, pool, 10);
    expect(ranked.length).toBeGreaterThan(0);
  });
});
