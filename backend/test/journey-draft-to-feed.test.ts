/**
 * End-to-end journey test — the symptom this v7 cycle set out to fix.
 *
 *   1. Owner creates a DRAFT property.
 *   2. Owner uploads an image AND a video (sign → PUT → finalize).
 *   3. Public feed must NOT list this property while it's DRAFT (admin
 *      review gate).
 *   4. Property transitions to PUBLISHED.
 *   5. Public feed must list the property with BOTH media assets
 *      projected as signed-download URLs that carry no Bearer token.
 *   6. A re-fetch (simulating a page reload) returns the same media
 *      (re-signed URLs — the sig may change but the asset count must
 *      remain the same).
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { buildTestApp, resetDb, shutdown } from './helpers.js';
import mediaRoutes from '../src/routes/media.js';
import propertyRoutes from '../src/routes/properties.js';
import { getPrisma } from '../src/db.js';

async function app() {
  return buildTestApp(async (a) => {
    await a.register(mediaRoutes);
    await a.register(propertyRoutes);
  });
}

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
// Minimal valid MP4 header — ISO/IEC 14496-12 ftyp box with brand
// 'isom'. The detector only inspects the first 12 bytes; the rest is
// opaque payload so the sandbox provider accepts it as-is.
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),       // box size (32)
  Buffer.from('ftyp', 'ascii'),                 // box type
  Buffer.from('isom', 'ascii'),                 // major brand
  Buffer.from([0x00, 0x00, 0x00, 0x01]),       // minor version
  Buffer.from('isomavc1', 'ascii'),             // compat brands
  Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),       // extra bytes to reach the declared box size
]);

function hex(buf: Buffer) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function signAndFinalize(a: Awaited<ReturnType<typeof app>>, userId: string, propertyId: string, bytes: Buffer, kind: 'image' | 'video', contentType: string) {
  const sign = await a.inject({
    method: 'POST', url: '/v1/media/upload-url',
    headers: { 'x-user-id': userId, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
    payload: { kind, contentType, sizeBytes: bytes.length, sha256: hex(bytes), propertyId, visibility: 'private' },
  });
  expect(sign.statusCode).toBe(200);
  const signed = sign.json() as { assetId: string; providerKey: string };
  const put = await a.inject({
    method: 'PUT', url: `/v1/media/sandbox-upload/${signed.providerKey}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  expect(put.statusCode).toBe(200);
  const fin = await a.inject({
    method: 'POST', url: '/v1/media',
    headers: { 'x-user-id': userId, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
    payload: {
      assetId: signed.assetId, providerKey: signed.providerKey,
      kind, contentType, sizeBytes: bytes.length, sha256: hex(bytes),
      propertyId, visibility: 'private',
    },
  });
  expect(fin.statusCode).toBe(200);
  return signed.assetId;
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

describe('end-to-end: owner draft → media save → publish → appears on homepage feed', () => {
  it('completes the full journey and keeps DRAFT off the public feed', async () => {
    const prisma = getPrisma();
    const owner = await prisma.user.create({ data: { phone: '+9660099001', nameAr: 'مالك جديد' } });

    // Step 1 — owner creates a DRAFT property.
    const prop = await prisma.property.create({ data: {
      listingNumber: 'JOURNEY-1', ownerId: owner.id,
      category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'DRAFT',
    } });

    const srv = await app();

    // Step 2 — upload an image and a video for the DRAFT property.
    const imgId = await signAndFinalize(srv, owner.id, prop.id, JPEG, 'image', 'image/jpeg');
    const vidId = await signAndFinalize(srv, owner.id, prop.id, MP4, 'video', 'video/mp4');
    expect(typeof imgId).toBe('string');
    expect(typeof vidId).toBe('string');

    // Step 3 — public feed hides DRAFT no matter how much media exists.
    const feedBefore = await srv.inject({ method: 'GET', url: '/v1/properties/feed?pageSize=20' });
    expect(feedBefore.statusCode).toBe(200);
    const bodyBefore = feedBefore.json() as { items: Array<{ listingNumber: string }> };
    expect(bodyBefore.items.map(x => x.listingNumber)).not.toContain('JOURNEY-1');

    // Step 4a — owner opts both media assets into public showcase via
    // the dedicated endpoint. This is the ONLY way an asset becomes
    // feed-eligible; the upload path hardcodes visibility=private.
    for (const assetId of [imgId, vidId]) {
      const r = await srv.inject({
        method: 'PATCH', url: '/v1/media/' + assetId + '/showcase',
        headers: { 'x-user-id': owner.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
        payload: { public: true },
      });
      expect(r.statusCode).toBe(200);
    }

    // Step 4b — transition DRAFT → PUBLISHED. In the real app this
    // happens via the admin review flow; here we hit the DB directly
    // because this test is about the feed/media contract, not the
    // transition rules (those have their own tests).
    await prisma.property.update({
      where: { id: prop.id },
      data: { advertisementLifecycle: 'PUBLISHED', publishedAt: new Date() },
    });

    // Step 5 — feed now returns the property WITH both media items.
    const feedAfter = await srv.inject({ method: 'GET', url: '/v1/properties/feed?pageSize=20' });
    expect(feedAfter.statusCode).toBe(200);
    const bodyAfter = feedAfter.json() as { items: Array<{ listingNumber: string; media: Array<{ kind: string; url: string; mimeType: string }> }> };
    const row = bodyAfter.items.find(x => x.listingNumber === 'JOURNEY-1');
    expect(row).toBeDefined();
    expect(row!.media.length).toBe(2);
    const kinds = row!.media.map(m => m.kind).sort();
    expect(kinds).toEqual(['image', 'video']);
    for (const m of row!.media) {
      expect(typeof m.url).toBe('string');
      expect(m.url.length).toBeGreaterThan(0);
      // Signed URL hygiene — no Bearer / Authorization anywhere.
      expect(m.url).not.toMatch(/[Bb]earer/);
      expect(m.url).not.toMatch(/[Aa]uthorization/);
    }

    // Step 6 — simulate a page reload. The response must be stable
    // (same asset count, same kinds) even though the signed URLs are
    // regenerated on every request.
    const reload = await srv.inject({ method: 'GET', url: '/v1/properties/feed?pageSize=20' });
    const bodyReload = reload.json() as { items: Array<{ listingNumber: string; media: unknown[] }> };
    const rowReload = bodyReload.items.find(x => x.listingNumber === 'JOURNEY-1');
    expect(rowReload).toBeDefined();
    expect(rowReload!.media.length).toBe(2);

    await srv.close();
  });

  it('a DRAFT with no media never leaks even when the owner is PUBLISHED-eligible later', async () => {
    const prisma = getPrisma();
    const owner = await prisma.user.create({ data: { phone: '+9660099002', nameAr: 'مالك آخر' } });
    await prisma.property.create({ data: {
      listingNumber: 'JOURNEY-2', ownerId: owner.id,
      category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'DRAFT',
    } });
    const srv = await app();
    const feed = await srv.inject({ method: 'GET', url: '/v1/properties/feed' });
    const body = feed.json() as { items: Array<{ listingNumber: string }> };
    expect(body.items.map(x => x.listingNumber)).not.toContain('JOURNEY-2');
    await srv.close();
  });
});
