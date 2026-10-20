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

  it('hides DRAFT properties from the public feed (v7 — admin-review gate)', async () => {
    const prisma = getPrisma();
    const u = await prisma.user.create({ data: { phone: '+9661113', nameAr: 'م' } });
    // Two listings: same owner, same type, both `status=available`. The
    // ONLY difference is lifecycle. The feed must return just the
    // PUBLISHED one — DRAFT is still waiting for admin review.
    await prisma.property.create({ data: {
      listingNumber: 'F-DRAFT', ownerId: u.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'DRAFT',
    } });
    await prisma.property.create({ data: {
      listingNumber: 'F-PUB', ownerId: u.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'PUBLISHED', publishedAt: new Date(),
    } });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties/feed?pageSize=20' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ listingNumber: string }>; total: number };
    const nums = body.items.map(x => x.listingNumber);
    expect(nums).toContain('F-PUB');
    expect(nums).not.toContain('F-DRAFT');
    await app.close();
  });

  it('projects ONLY visibility=public owner media as signed URLs onto the feed row', async () => {
    const prisma = getPrisma();
    const u = await prisma.user.create({ data: { phone: '+9661200', nameAr: 'م' } });
    const p = await prisma.property.create({ data: {
      listingNumber: 'F-MEDIA', ownerId: u.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'PUBLISHED', publishedAt: new Date(),
    } });
    // Seed public image + public video + private image. The private
    // one must NOT appear in the feed row's media array even though
    // the property is PUBLISHED.
    await prisma.mediaAsset.createMany({ data: [
      { ownerUserId: u.id, propertyId: p.id, kind: 'image',
        provider: 'local', providerKey: 'img-' + p.id, mimeType: 'image/jpeg',
        sizeBytes: 1000, sha256: 'a'.repeat(64), visibility: 'public' },
      { ownerUserId: u.id, propertyId: p.id, kind: 'video',
        provider: 'local', providerKey: 'vid-' + p.id, mimeType: 'video/mp4',
        sizeBytes: 5000, sha256: 'b'.repeat(64), visibility: 'public' },
      { ownerUserId: u.id, propertyId: p.id, kind: 'image',
        provider: 'local', providerKey: 'priv-' + p.id, mimeType: 'image/jpeg',
        sizeBytes: 2000, sha256: 'c'.repeat(64), visibility: 'private' },
    ] });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties/feed' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ listingNumber: string; media?: Array<{ kind: string; url: string; mimeType: string }> }> };
    const row = body.items.find(x => x.listingNumber === 'F-MEDIA');
    expect(row).toBeDefined();
    expect(Array.isArray(row!.media)).toBe(true);
    expect(row!.media!.length).toBe(2);
    expect(row!.media![0]!.kind).toBe('image');
    expect(typeof row!.media![0]!.url).toBe('string');
    expect(row!.media![0]!.url.length).toBeGreaterThan(0);
    // Signed URL must NOT carry a Bearer token under any provider.
    expect(row!.media![0]!.url).not.toMatch(/[Bb]earer/);
    expect(row!.media![0]!.url).not.toMatch(/[Aa]uthorization/);
    expect(row!.media![1]!.kind).toBe('video');
    expect(row!.media![1]!.mimeType).toBe('video/mp4');
    await app.close();
  });

  it('returns media:[] for a PUBLISHED property that has no uploads yet', async () => {
    const prisma = getPrisma();
    const u = await prisma.user.create({ data: { phone: '+9661201', nameAr: 'م' } });
    await prisma.property.create({ data: {
      listingNumber: 'F-EMPTY-MEDIA', ownerId: u.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'PUBLISHED', publishedAt: new Date(),
    } });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties/feed' });
    const body = res.json() as { items: Array<{ listingNumber: string; media?: unknown[] }> };
    const row = body.items.find(x => x.listingNumber === 'F-EMPTY-MEDIA');
    expect(row).toBeDefined();
    expect(row!.media).toEqual([]);
    await app.close();
  });

  it('does NOT project media of DRAFT properties to the public feed', async () => {
    const prisma = getPrisma();
    const u = await prisma.user.create({ data: { phone: '+9661202', nameAr: 'م' } });
    const p = await prisma.property.create({ data: {
      listingNumber: 'F-DRAFT-MEDIA', ownerId: u.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'DRAFT',
    } });
    await prisma.mediaAsset.create({ data: {
      ownerUserId: u.id, propertyId: p.id, kind: 'image',
      provider: 'local', providerKey: 'img-draft-' + p.id, mimeType: 'image/jpeg',
      sizeBytes: 1000, sha256: 'c'.repeat(64), visibility: 'private',
    } });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties/feed' });
    const body = res.json() as { items: Array<{ listingNumber: string }> };
    expect(body.items.map(x => x.listingNumber)).not.toContain('F-DRAFT-MEDIA');
    await app.close();
  });

  it('HIDES VERIFIED listings from the public feed — admin publish is a separate step', async () => {
    const prisma = getPrisma();
    const u = await prisma.user.create({ data: { phone: '+9661114', nameAr: 'م' } });
    await prisma.property.create({ data: {
      listingNumber: 'F-VER', ownerId: u.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'VERIFIED',
    } });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties/feed' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ listingNumber: string }> };
    expect(body.items.map(x => x.listingNumber)).not.toContain('F-VER');
    await app.close();
  });

  it('private media of a PUBLISHED property stays private — never leaks even to its own feed row', async () => {
    const prisma = getPrisma();
    const u = await prisma.user.create({ data: { phone: '+9661115', nameAr: 'م' } });
    const p = await prisma.property.create({ data: {
      listingNumber: 'F-PRIV-ONLY', ownerId: u.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'PUBLISHED', publishedAt: new Date(),
    } });
    // Owner has uploaded media but NEVER opted it into showcase. The
    // feed row for this property exists (it is PUBLISHED) but its
    // media array must be empty — nothing was marked public.
    await prisma.mediaAsset.createMany({ data: [
      { ownerUserId: u.id, propertyId: p.id, kind: 'image',
        provider: 'local', providerKey: 'priv-img-' + p.id, mimeType: 'image/jpeg',
        sizeBytes: 1000, sha256: 'd'.repeat(64), visibility: 'private' },
      { ownerUserId: u.id, propertyId: p.id, kind: 'video',
        provider: 'local', providerKey: 'priv-vid-' + p.id, mimeType: 'video/mp4',
        sizeBytes: 2000, sha256: 'e'.repeat(64), visibility: 'private' },
    ] });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties/feed' });
    const body = res.json() as { items: Array<{ listingNumber: string; media: unknown[] }> };
    const row = body.items.find(x => x.listingNumber === 'F-PRIV-ONLY');
    expect(row).toBeDefined();
    expect(row!.media).toEqual([]);
    await app.close();
  });

  it('showcase flag on a VERIFIED property still does not leak — property publish required', async () => {
    const prisma = getPrisma();
    const u = await prisma.user.create({ data: { phone: '+9661116', nameAr: 'م' } });
    const p = await prisma.property.create({ data: {
      listingNumber: 'F-VER-PUB-MEDIA', ownerId: u.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'VERIFIED',
    } });
    await prisma.mediaAsset.create({ data: {
      ownerUserId: u.id, propertyId: p.id, kind: 'image',
      provider: 'local', providerKey: 'pub-vp-' + p.id, mimeType: 'image/jpeg',
      sizeBytes: 1000, sha256: 'f'.repeat(64), visibility: 'public',
    } });
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties/feed' });
    const body = res.json() as { items: Array<{ listingNumber: string }> };
    expect(body.items.map(x => x.listingNumber)).not.toContain('F-VER-PUB-MEDIA');
    await app.close();
  });

  it('projectFeedMedia uses per-property fetches — a crowded property does not starve others', async () => {
    const prisma = getPrisma();
    const u = await prisma.user.create({ data: { phone: '+9661117', nameAr: 'م' } });
    // Create 4 PUBLISHED properties, each with one public image.
    const props = [] as string[];
    for (let i = 0; i < 4; i++) {
      const p = await prisma.property.create({ data: {
        listingNumber: 'F-STARVE-' + i, ownerId: u.id, category: 'apartment', purpose: 'rent',
        advertisementLifecycle: 'PUBLISHED', publishedAt: new Date(),
      } });
      props.push(p.id);
    }
    // Property[0] additionally has 20 public images — enough to blow
    // past any naive global `take: n*6` limit. We ONLY care that each
    // of the four properties still gets exactly one image URL.
    for (let i = 0; i < 20; i++) {
      await prisma.mediaAsset.create({ data: {
        ownerUserId: u.id, propertyId: props[0]!, kind: 'image',
        provider: 'local', providerKey: `crowded-${i}-${props[0]}`, mimeType: 'image/jpeg',
        sizeBytes: 1000, sha256: 'g'.repeat(64), visibility: 'public',
      } });
    }
    for (let i = 1; i < 4; i++) {
      await prisma.mediaAsset.create({ data: {
        ownerUserId: u.id, propertyId: props[i]!, kind: 'image',
        provider: 'local', providerKey: `hero-${i}-${props[i]}`, mimeType: 'image/jpeg',
        sizeBytes: 1000, sha256: 'h'.repeat(64), visibility: 'public',
      } });
    }
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties/feed?pageSize=20' });
    const body = res.json() as { items: Array<{ listingNumber: string; media: Array<{ kind: string }> }> };
    for (let i = 0; i < 4; i++) {
      const row = body.items.find(x => x.listingNumber === 'F-STARVE-' + i);
      expect(row, 'row F-STARVE-' + i).toBeDefined();
      const imageCount = row!.media.filter(m => m.kind === 'image').length;
      expect(imageCount, 'image count for F-STARVE-' + i).toBe(1);
    }
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
