/**
 * Tests for /v1/tours — property tour ownership + publish guard.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { resetDb, shutdown, buildTestApp } from './helpers.js';
import tourRoutes from '../src/routes/tours.js';
import { getPrisma } from '../src/db.js';
import { featureFlags } from '../src/config/feature-flags.js';

async function server() {
  return buildTestApp(async (app) => { await app.register(tourRoutes); });
}

async function seedOwnerAndProperty() {
  const prisma = getPrisma();
  const owner = await prisma.user.create({ data: { phone: '+9662201', nameAr: 'المالك' } });
  const other = await prisma.user.create({ data: { phone: '+9662202', nameAr: 'آخر' } });
  const property = await prisma.property.create({
    data: {
      listingNumber: `L-T-${Date.now()}`,
      ownerId: owner.id, category: 'apartment', purpose: 'daily',
    },
  });
  const asset = await prisma.mediaAsset.create({
    data: {
      ownerUserId: owner.id, propertyId: property.id,
      kind: 'image', provider: 'sandbox', providerKey: 'k1',
      mimeType: 'image/jpeg', sizeBytes: 1024, sha256: 'b'.repeat(64),
    },
  });
  return { owner, other, property, asset };
}

beforeEach(async () => {
  await resetDb();
  featureFlags.PROPERTY_3D_VIEWER_ENABLED = true;
});
afterEach(() => {
  featureFlags.PROPERTY_3D_VIEWER_ENABLED = false;
});
afterAll(async () => { await shutdown(); });

describe('feature-flag gating', () => {
  it('returns 404 when PROPERTY_3D_VIEWER_ENABLED is off', async () => {
    featureFlags.PROPERTY_3D_VIEWER_ENABLED = false;
    const app = await server();
    const res = await app.inject({
      method: 'GET', url: '/v1/tours?propertyId=x',
      headers: { 'x-user-id': 'u', 'x-user-role': 'CUSTOMER' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('ownership', () => {
  it('forbids creating a tour for another user\'s property', async () => {
    const { other, property } = await seedOwnerAndProperty();
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/tours',
      payload: { propertyId: property.id, tourType: 'panorama_360' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': other.id, 'x-user-role': 'HOST',
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets the property owner create a tour', async () => {
    const { owner, property } = await seedOwnerAndProperty();
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/tours',
      payload: { propertyId: property.id, tourType: 'panorama_360', title: 'صالة' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': owner.id, 'x-user-role': 'HOST',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('draft');
    expect(res.json().ownerUserId).toBe(owner.id);
    await app.close();
  });
});

describe('publish guard', () => {
  it('rejects publishing without a primaryAssetId', async () => {
    const { owner, property } = await seedOwnerAndProperty();
    const prisma = getPrisma();
    const tour = await prisma.propertyTour.create({
      data: { propertyId: property.id, ownerUserId: owner.id, tourType: 'gaussian_splat' },
    });
    const app = await server();
    const res = await app.inject({
      method: 'PATCH', url: `/v1/tours/${tour.id}`,
      payload: { status: 'published' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': owner.id, 'x-user-role': 'HOST',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/primaryAssetId/i);
    await app.close();
  });

  it('publishes a tour once a primaryAssetId is set', async () => {
    const { owner, property, asset } = await seedOwnerAndProperty();
    const prisma = getPrisma();
    const tour = await prisma.propertyTour.create({
      data: { propertyId: property.id, ownerUserId: owner.id, tourType: 'panorama_360' },
    });
    const app = await server();
    const res = await app.inject({
      method: 'PATCH', url: `/v1/tours/${tour.id}`,
      payload: { status: 'published', primaryAssetId: asset.id },
      headers: {
        'content-type': 'application/json',
        'x-user-id': owner.id, 'x-user-role': 'HOST',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('published');
    expect(res.json().publishedAt).not.toBeNull();
    await app.close();
  });
});

describe('visibility', () => {
  it('lists only published tours for non-owners', async () => {
    const { owner, other, property, asset } = await seedOwnerAndProperty();
    const prisma = getPrisma();
    await prisma.propertyTour.create({
      data: { propertyId: property.id, ownerUserId: owner.id, tourType: 'panorama_360', status: 'draft' },
    });
    await prisma.propertyTour.create({
      data: {
        propertyId: property.id, ownerUserId: owner.id, tourType: 'panorama_360',
        status: 'published', primaryAssetId: asset.id, publishedAt: new Date(),
      },
    });
    const app = await server();
    const asOther = await app.inject({
      method: 'GET', url: `/v1/tours?propertyId=${property.id}`,
      headers: { 'x-user-id': other.id, 'x-user-role': 'CUSTOMER' },
    });
    expect(asOther.statusCode).toBe(200);
    expect(asOther.json().items).toHaveLength(1);
    const asOwner = await app.inject({
      method: 'GET', url: `/v1/tours?propertyId=${property.id}`,
      headers: { 'x-user-id': owner.id, 'x-user-role': 'HOST' },
    });
    expect(asOwner.json().items).toHaveLength(2);
    await app.close();
  });
});
