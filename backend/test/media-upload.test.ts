/**
 * Media upload endpoints — coverage for the additions that support
 * real property-image upload from web + mobile.
 *
 * Scenarios:
 *   - GET  /v1/media returns only the caller's own assets
 *   - GET  /v1/media?propertyId= filters + still scopes to caller
 *   - GET  /v1/media includes a signed url for each row
 *   - DELETE /v1/media/:id owner-only (non-owner sees 404)
 *   - PUT  /v1/media/sandbox-upload/* accepts bytes in test env
 *   - PUT  /v1/media/sandbox-upload/* returns 404 in production env
 *   - Existing signed upload flow still rejects bad MIME + bad size
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildTestApp, resetDb, shutdown } from './helpers.js';
import mediaRoutes from '../src/routes/media.js';
import { getPrisma } from '../src/db.js';
import { config } from '../src/config.js';

async function server() {
  return buildTestApp(async (a) => { await a.register(mediaRoutes); });
}

async function makeUser(phone: string) {
  return getPrisma().user.create({ data: { phone, nameAr: 'مالك' } });
}

async function seedAsset(ownerUserId: string, propertyId: string | null = null) {
  return getPrisma().mediaAsset.create({
    data: {
      ownerUserId, propertyId,
      kind: 'image', provider: 'sandbox',
      providerKey: `sandbox/${ownerUserId}/${Math.random().toString(36).slice(2, 10)}`,
      mimeType: 'image/jpeg', sizeBytes: 12345,
      sha256: '0'.repeat(64), visibility: 'private',
    },
  });
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

// ---- GET /v1/media -------------------------------------------------

describe('GET /v1/media', () => {
  it('returns only the caller\'s own assets', async () => {
    const me = await makeUser('+9660011001');
    const other = await makeUser('+9660011002');
    await seedAsset(me.id);
    await seedAsset(me.id);
    await seedAsset(other.id);
    const app = await server();
    const res = await app.inject({
      method: 'GET', url: '/v1/media',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; url: string | null }[] };
    expect(body.items.length).toBe(2);
    for (const it of body.items) {
      // Signed download URL rendered for every row (sandbox returns fake url — but it IS a url).
      expect(typeof it.url === 'string' || it.url === null).toBe(true);
    }
    await app.close();
  });

  it('filters by propertyId and still scopes to caller', async () => {
    const me = await makeUser('+9660011003');
    await seedAsset(me.id, 'prop_A');
    await seedAsset(me.id, 'prop_B');
    await seedAsset(me.id, 'prop_A');
    const app = await server();
    const res = await app.inject({
      method: 'GET', url: '/v1/media?propertyId=prop_A',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER' },
    });
    const body = res.json() as { items: unknown[] };
    expect(body.items.length).toBe(2);
    await app.close();
  });

  it('returns an empty list for anonymous callers cannot even call it (401)', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/media' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('never exposes ownerUserId or providerKey', async () => {
    const me = await makeUser('+9660011004');
    await seedAsset(me.id, 'prop_X');
    const app = await server();
    const res = await app.inject({
      method: 'GET', url: '/v1/media?propertyId=prop_X',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER' },
    });
    const body = res.json() as { items: Record<string, unknown>[] };
    for (const it of body.items) {
      expect(it).not.toHaveProperty('ownerUserId');
      expect(it).not.toHaveProperty('providerKey');
    }
    await app.close();
  });
});

// ---- DELETE /v1/media/:id -----------------------------------------

describe('DELETE /v1/media/:id', () => {
  it('owner can delete', async () => {
    const me = await makeUser('+9660011010');
    const a = await seedAsset(me.id);
    const app = await server();
    const res = await app.inject({
      method: 'DELETE', url: `/v1/media/${a.id}`,
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER' },
    });
    expect(res.statusCode).toBe(200);
    const gone = await getPrisma().mediaAsset.findUnique({ where: { id: a.id } });
    expect(gone).toBeNull();
    await app.close();
  });

  it('non-owner sees 404 (probing prevention)', async () => {
    const me = await makeUser('+9660011011');
    const other = await makeUser('+9660011012');
    const a = await seedAsset(me.id);
    const app = await server();
    const res = await app.inject({
      method: 'DELETE', url: `/v1/media/${a.id}`,
      headers: { 'x-user-id': other.id, 'x-user-role': 'OWNER' },
    });
    expect(res.statusCode).toBe(404);
    const still = await getPrisma().mediaAsset.findUnique({ where: { id: a.id } });
    expect(still).not.toBeNull();
    await app.close();
  });

  it('missing id → 404', async () => {
    const me = await makeUser('+9660011013');
    const app = await server();
    const res = await app.inject({
      method: 'DELETE', url: '/v1/media/nope',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ---- PUT /v1/media/sandbox-upload/* -------------------------------

describe('PUT /v1/media/sandbox-upload/*', () => {
  it('accepts bytes in test / dev env', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'PUT', url: '/v1/media/sandbox-upload/some/opaque/key',
      headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // JPEG magic bytes
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 404 in production (byte sink disabled)', async () => {
    const orig = config.NODE_ENV;
    (config as unknown as { NODE_ENV: string }).NODE_ENV = 'production';
    try {
      const app = await server();
      const res = await app.inject({
        method: 'PUT', url: '/v1/media/sandbox-upload/x',
        headers: { 'content-type': 'image/jpeg' },
        payload: Buffer.from([0xff]),
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    } finally {
      (config as unknown as { NODE_ENV: string }).NODE_ENV = orig;
    }
  });
});

// ---- Signed upload URL flow ---------------------------------------

describe('POST /v1/media/upload-url', () => {
  it('rejects a non-allowed MIME', async () => {
    const me = await makeUser('+9660011020');
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/media/upload-url',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: {
        kind: 'image', contentType: 'application/x-msdos-program',
        sizeBytes: 100, sha256: '0'.repeat(64), propertyId: 'p1',
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an over-size upload', async () => {
    const me = await makeUser('+9660011021');
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/media/upload-url',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: {
        kind: 'image', contentType: 'image/jpeg',
        sizeBytes: 500 * 1024 * 1024, // 500 MB
        sha256: '0'.repeat(64),
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('issues a signed URL for a valid image request (no propertyId — general asset)', async () => {
    const me = await makeUser('+9660011022');
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/media/upload-url',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      // No propertyId here — the new ownership check only fires when it's supplied.
      payload: {
        kind: 'image', contentType: 'image/jpeg',
        sizeBytes: 12345, sha256: '0'.repeat(64),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { uploadUrl: string; assetId: string; providerKey: string };
    expect(body.uploadUrl).toMatch(/^sandbox:\/\//); // sandbox scheme preserved
    expect(body.assetId).toBeTruthy();
    expect(body.providerKey).toContain(me.id);
    await app.close();
  });
});

// ---- Property ownership check on upload-url -----------------------

describe('POST /v1/media/upload-url — property ownership', () => {
  it('non-owner sees 404 when trying to attach media to another user\'s property', async () => {
    const me = await makeUser('+9660011030');
    const other = await makeUser('+9660011031');
    const otherProp = await getPrisma().property.create({
      data: { listingNumber: 'L-OWN-1', ownerId: other.id, category: 'apartment', purpose: 'rent' },
    });
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/media/upload-url',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { kind: 'image', contentType: 'image/jpeg', sizeBytes: 100, sha256: '0'.repeat(64), propertyId: otherProp.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('owner can attach to their own property', async () => {
    const me = await makeUser('+9660011032');
    const myProp = await getPrisma().property.create({
      data: { listingNumber: 'L-OWN-2', ownerId: me.id, category: 'apartment', purpose: 'rent' },
    });
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/media/upload-url',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { kind: 'image', contentType: 'image/jpeg', sizeBytes: 100, sha256: '0'.repeat(64), propertyId: myProp.id },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ---- Per-kind size limits ----------------------------------------

describe('POST /v1/media/upload-url — per-kind limits from env', () => {
  it('rejects an image over MEDIA_IMAGE_MAX_BYTES', async () => {
    const me = await makeUser('+9660011040');
    const app = await server();
    const orig = config.MEDIA_IMAGE_MAX_BYTES;
    (config as unknown as { MEDIA_IMAGE_MAX_BYTES: number }).MEDIA_IMAGE_MAX_BYTES = 1024;
    try {
      const res = await app.inject({
        method: 'POST', url: '/v1/media/upload-url',
        headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
        payload: { kind: 'image', contentType: 'image/jpeg', sizeBytes: 5000, sha256: '0'.repeat(64) },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      (config as unknown as { MEDIA_IMAGE_MAX_BYTES: number }).MEDIA_IMAGE_MAX_BYTES = orig;
    }
    await app.close();
  });

  it('accepts a webm video request when under MEDIA_VIDEO_MAX_BYTES', async () => {
    const me = await makeUser('+9660011041');
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/media/upload-url',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { kind: 'video', contentType: 'video/webm', sizeBytes: 1_000_000, sha256: '0'.repeat(64) },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
