/**
 * PATCH /v1/media/:id/showcase — the ONLY endpoint that turns a
 * MediaAsset's visibility public. Tested in isolation:
 *
 *   - Owner can toggle their own asset on and off.
 *   - A non-owner sees 404 (never 403 — IDs are not probable).
 *   - The upload path keeps visibility=private regardless of payload.
 *   - A toggled-public asset becomes feed-eligible once the parent
 *     property reaches PUBLISHED (regression against §2 of v7-r2).
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { buildTestApp, resetDb, shutdown } from './helpers.js';
import mediaRoutes from '../src/routes/media.js';
import propertyRoutes from '../src/routes/properties.js';
import { getPrisma } from '../src/db.js';

async function server() {
  return buildTestApp(async (a) => {
    await a.register(mediaRoutes);
    await a.register(propertyRoutes);
  });
}

async function makeUser(phone: string) {
  return getPrisma().user.create({ data: { phone, nameAr: 'مالك' } });
}

async function seedAsset(ownerUserId: string, propertyId: string | null = null) {
  return getPrisma().mediaAsset.create({
    data: {
      ownerUserId, propertyId, kind: 'image', provider: 'sandbox',
      providerKey: `sandbox/${ownerUserId}/${Math.random().toString(36).slice(2, 10)}`,
      mimeType: 'image/jpeg', sizeBytes: 1000,
      sha256: '0'.repeat(64), visibility: 'private',
    },
  });
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

describe('PATCH /v1/media/:id/showcase', () => {
  it('owner flips visibility to public, then back to private', async () => {
    const me = await makeUser('+9660022001');
    const a = await seedAsset(me.id);
    const app = await server();
    const on = await app.inject({
      method: 'PATCH', url: `/v1/media/${a.id}/showcase`,
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { public: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json() as { visibility: string }).toMatchObject({ visibility: 'public' });
    const off = await app.inject({
      method: 'PATCH', url: `/v1/media/${a.id}/showcase`,
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { public: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json() as { visibility: string }).toMatchObject({ visibility: 'private' });
    await app.close();
  });

  it('non-owner sees 404 (same shape as "not found") — IDs are not probable', async () => {
    const me = await makeUser('+9660022002');
    const other = await makeUser('+9660022003');
    const a = await seedAsset(me.id);
    const app = await server();
    const r = await app.inject({
      method: 'PATCH', url: `/v1/media/${a.id}/showcase`,
      headers: { 'x-user-id': other.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { public: true },
    });
    expect(r.statusCode).toBe(404);
    // DB row must stay private because the request was rejected.
    const after = await getPrisma().mediaAsset.findUnique({ where: { id: a.id } });
    expect(after?.visibility).toBe('private');
    await app.close();
  });

  it('toggled-public asset surfaces in the feed once its parent property is PUBLISHED', async () => {
    const me = await makeUser('+9660022004');
    const p = await getPrisma().property.create({ data: {
      listingNumber: 'SHOW-1', ownerId: me.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'DRAFT',
    } });
    const a = await seedAsset(me.id, p.id);
    const app = await server();
    await app.inject({
      method: 'PATCH', url: `/v1/media/${a.id}/showcase`,
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { public: true },
    });
    // Still DRAFT → no feed row, no media.
    const feedDraft = await app.inject({ method: 'GET', url: '/v1/properties/feed' });
    expect((feedDraft.json() as { items: Array<{ listingNumber: string }> }).items.map(x => x.listingNumber))
      .not.toContain('SHOW-1');
    await getPrisma().property.update({
      where: { id: p.id },
      data: { advertisementLifecycle: 'PUBLISHED', publishedAt: new Date() },
    });
    const feedPub = await app.inject({ method: 'GET', url: '/v1/properties/feed' });
    const row = (feedPub.json() as { items: Array<{ listingNumber: string; media: unknown[] }> })
      .items.find(x => x.listingNumber === 'SHOW-1');
    expect(row).toBeDefined();
    expect(row!.media.length).toBe(1);
    await app.close();
  });

  it('finalize of a new upload keeps visibility=private even when the client sends visibility=public', async () => {
    const me = await makeUser('+9660022005');
    const app = await server();
    // Mimic the full sign → PUT → finalize flow with a visibility=public
    // payload. The server must coerce visibility back to 'private'.
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
      0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
    const sha = crypto.createHash('sha256').update(JPEG).digest('hex');
    const sign = await app.inject({
      method: 'POST', url: '/v1/media/upload-url',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { kind: 'image', contentType: 'image/jpeg', sizeBytes: JPEG.length, sha256: sha, visibility: 'public' },
    });
    // The sign endpoint silently coerces visibility back to private.
    expect(sign.statusCode).toBe(200);
    const signed = sign.json() as { assetId: string; providerKey: string };
    await app.inject({
      method: 'PUT', url: `/v1/media/sandbox-upload/${signed.providerKey}`,
      headers: { 'content-type': 'application/octet-stream' }, payload: JPEG,
    });
    const fin = await app.inject({
      method: 'POST', url: '/v1/media',
      headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
      payload: { assetId: signed.assetId, providerKey: signed.providerKey },
    });
    expect(fin.statusCode).toBe(200);
    const asset = await getPrisma().mediaAsset.findUnique({ where: { id: signed.assetId } });
    expect(asset?.visibility).toBe('private');
    await app.close();
  });
});
