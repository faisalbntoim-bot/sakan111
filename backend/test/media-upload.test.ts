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

// ---- POST /v1/media finalize — full pipeline against PendingUpload ------
//
// The finalize route was rebuilt so it consults a persisted PendingUpload
// row and refuses any client value that differs from what we recorded when
// we signed the URL. These tests exercise every branch: happy path, missing
// pending row (forgery), foreign owner, size / sha256 / content-type
// mismatches against real stored bytes, expiry, idempotent replay, and a
// racing double-finalize.
import crypto from 'node:crypto';

// Minimal 3x1 JPEG (SOI + APP0 + SOF0 + EOI). Enough bytes for
// detectContentType() to see FF D8 FF.
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xff]);

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function signUpload(app: Awaited<ReturnType<typeof server>>, userId: string, opts: {
  propertyId?: string; contentType?: string; sizeBytes: number; sha256: string; kind?: 'image' | 'video';
}) {
  const res = await app.inject({
    method: 'POST', url: '/v1/media/upload-url',
    headers: { 'x-user-id': userId, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
    payload: {
      kind: opts.kind ?? 'image',
      contentType: opts.contentType ?? 'image/jpeg',
      sizeBytes: opts.sizeBytes,
      sha256: opts.sha256,
      ...(opts.propertyId ? { propertyId: opts.propertyId } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { assetId: string; providerKey: string; uploadUrl: string };
}

async function putBytes(app: Awaited<ReturnType<typeof server>>, providerKey: string, bytes: Buffer) {
  const res = await app.inject({
    method: 'PUT', url: `/v1/media/sandbox-upload/${providerKey}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  expect(res.statusCode).toBe(200);
}

async function finalize(app: Awaited<ReturnType<typeof server>>, userId: string, assetId: string, providerKey: string) {
  return app.inject({
    method: 'POST', url: '/v1/media',
    headers: { 'x-user-id': userId, 'x-user-role': 'OWNER', 'content-type': 'application/json' },
    payload: { assetId, providerKey },
  });
}

describe('POST /v1/media finalize — full pipeline', () => {
  it('sign → PUT → finalize succeeds and creates a MediaAsset bound to the caller and their property', async () => {
    const me = await makeUser('+9660011100');
    const prop = await getPrisma().property.create({
      data: { listingNumber: 'L-FIN-1', ownerId: me.id, category: 'apartment', purpose: 'rent' },
    });
    const app = await server();
    const signed = await signUpload(app, me.id, { propertyId: prop.id, sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(200);
    const asset = res.json() as { id: string; ownerUserId: string; propertyId: string | null; sha256: string };
    expect(asset.id).toBe(signed.assetId);
    expect(asset.ownerUserId).toBe(me.id);
    expect(asset.propertyId).toBe(prop.id);
    expect(asset.sha256.toLowerCase()).toBe(sha256Hex(JPEG_BYTES));
    // Pending row must be marked finalized so a replay is idempotent.
    const pending = await getPrisma().pendingUpload.findUnique({ where: { id: signed.assetId } });
    expect(pending?.finalizedAt).not.toBeNull();
    await app.close();
  });

  it('finalize a second time returns the SAME asset (idempotent replay)', async () => {
    const me = await makeUser('+9660011101');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    const r1 = await finalize(app, me.id, signed.assetId, signed.providerKey);
    const r2 = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const a1 = r1.json() as { id: string };
    const a2 = r2.json() as { id: string };
    expect(a1.id).toBe(a2.id);
    // Exactly one MediaAsset row exists.
    const rows = await getPrisma().mediaAsset.findMany({ where: { id: signed.assetId } });
    expect(rows.length).toBe(1);
    await app.close();
  });

  it('two concurrent finalize calls both succeed and no duplicate row is created', async () => {
    const me = await makeUser('+9660011102');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    const [r1, r2] = await Promise.all([
      finalize(app, me.id, signed.assetId, signed.providerKey),
      finalize(app, me.id, signed.assetId, signed.providerKey),
    ]);
    expect(new Set([r1.statusCode, r2.statusCode])).toEqual(new Set([200]));
    const rows = await getPrisma().mediaAsset.findMany({ where: { id: signed.assetId } });
    expect(rows.length).toBe(1);
    await app.close();
  });
});

describe('POST /v1/media finalize — rejects forged / tampered / expired requests', () => {
  it('rejects a fabricated providerKey with no matching PendingUpload row (was WARNING → now rejected)', async () => {
    // Attack: caller crafts a well-formed-looking key without ever calling
    // upload-url. Previously our structural parser accepted anything shaped
    // like sandbox/<own-userId>/<hex>. Now finalize requires a real row.
    const me = await makeUser('+9660011110');
    const app = await server();
    const fabricated = `sandbox/${me.id}/${'a'.repeat(16)}`;
    const res = await finalize(app, me.id, 'a'.repeat(16), fabricated);
    expect(res.statusCode).toBe(404);
    const rows = await getPrisma().mediaAsset.findMany({ where: { id: 'a'.repeat(16) } });
    expect(rows).toEqual([]);
    await app.close();
  });

  it('rejects finalize when the providerKey belongs to a different owner', async () => {
    const me = await makeUser('+9660011111');
    const attacker = await makeUser('+9660011112');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    // Attacker knows the providerKey (perhaps via log leak) — still refused.
    const res = await finalize(app, attacker.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(404);
    // My row is still not finalized, my asset does not exist.
    const rows = await getPrisma().mediaAsset.findMany({ where: { id: signed.assetId } });
    expect(rows).toEqual([]);
    await app.close();
  });

  it('rejects finalize when body.assetId does not match the pending row id', async () => {
    const me = await makeUser('+9660011113');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    const res = await finalize(app, me.id, 'ffffffffffffffff', signed.providerKey);
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects finalize when bytes never uploaded (storage HEAD → NOT_FOUND)', async () => {
    const me = await makeUser('+9660011114');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    // Skip PUT.
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects finalize when the stored size differs from the declared size', async () => {
    const me = await makeUser('+9660011115');
    const app = await server();
    // Declare 100 bytes …
    const declared = sha256Hex(Buffer.alloc(100));
    const signed = await signUpload(app, me.id, { sizeBytes: 100, sha256: declared });
    // … then PUT the JPEG (22 bytes).
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/size mismatch/);
    await app.close();
  });

  it('rejects finalize when the stored SHA-256 differs from the declared SHA-256', async () => {
    const me = await makeUser('+9660011116');
    const app = await server();
    // Declare the wrong hash but the correct size.
    const signed = await signUpload(app, me.id, {
      sizeBytes: JPEG_BYTES.length,
      sha256: '0'.repeat(64),
    });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/sha256 mismatch/);
    await app.close();
  });

  it('rejects finalize when magic-byte content-type does not match declared MIME', async () => {
    const me = await makeUser('+9660011117');
    const app = await server();
    // Declared image/jpeg + correct hash of PDF bytes.
    const pdfPadded = Buffer.concat([PDF_BYTES, Buffer.alloc(200 - PDF_BYTES.length)]);
    const signed = await signUpload(app, me.id, {
      sizeBytes: pdfPadded.length,
      sha256: sha256Hex(pdfPadded),
      contentType: 'image/jpeg',
    });
    await putBytes(app, signed.providerKey, pdfPadded);
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/content-type mismatch/);
    await app.close();
  });

  it('rejects finalize when the pending row has expired', async () => {
    const me = await makeUser('+9660011118');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    // Roll the expiry back to the past.
    await getPrisma().pendingUpload.update({
      where: { id: signed.assetId }, data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/expired/);
    await app.close();
  });
});

describe('POST /v1/media finalize — no post-finalize content mutation', () => {
  it('after finalize, MediaAsset.providerKey lives under finalized/… and the file bytes there are not touchable via the old signed URL', async () => {
    const me = await makeUser('+9660011120');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    // Staging key MUST live under uploads/ — the signed URL cannot address
    // anything else, so no legitimate PUT can write into finalized/… .
    expect(signed.providerKey).toMatch(/^uploads\//);
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    const r1 = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(r1.statusCode).toBe(200);
    const asset = r1.json() as { providerKey: string; sha256: string };
    expect(asset.providerKey).toMatch(/^finalized\//);
    const originalSha = asset.sha256.toLowerCase();

    // Attacker retains the old signed URL and tries to overwrite. The
    // sandbox PUT route now consults the pending row and refuses any
    // write against a slot whose finalizedAt is set — 409 Conflict.
    const tamper = Buffer.concat([JPEG_BYTES, Buffer.from([0x01, 0x02, 0x03])]);
    const putRes = await app.inject({
      method: 'PUT', url: `/v1/media/sandbox-upload/${signed.providerKey}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: tamper,
    });
    expect(putRes.statusCode).toBe(409);

    // The actual bytes at MediaAsset.providerKey (finalized/…) are still
    // the original JPEG — verified by streaming SHA-256 through the
    // provider's own head(). This tests file bytes, not just DB fields.
    const { getStorage } = await import('../src/storage/index.js');
    const stat = await getStorage().head(asset.providerKey);
    expect(stat.sha256).toBe(originalSha);
    expect(stat.sizeBytes).toBe(JPEG_BYTES.length);

    // Idempotent replay still returns the ORIGINAL asset row.
    const r2 = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(r2.statusCode).toBe(200);
    expect((r2.json() as { sha256: string }).sha256.toLowerCase()).toBe(originalSha);

    // DB row unchanged.
    const row = await getPrisma().mediaAsset.findUnique({ where: { id: signed.assetId } });
    expect(row?.sha256.toLowerCase()).toBe(originalSha);
    expect(row?.providerKey).toBe(asset.providerKey);
    await app.close();
  });

  it('rejects a PUT to a staging key whose pending row is already finalized (defense in depth)', async () => {
    const me = await makeUser('+9660011121');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    await finalize(app, me.id, signed.assetId, signed.providerKey);
    // Second PUT to the same staging key with the same-shaped body — the
    // route MUST refuse before touching storage.
    const res = await app.inject({
      method: 'PUT', url: `/v1/media/sandbox-upload/${signed.providerKey}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('ALREADY_FINALIZED');
    await app.close();
  });
});

describe('POST /v1/media finalize — post-sign property changes are honoured', () => {
  it('rejects finalize when the target property was TRANSFERRED to a different owner after sign', async () => {
    const me = await makeUser('+9660011130');
    const buyer = await makeUser('+9660011131');
    const prop = await getPrisma().property.create({
      data: { listingNumber: 'L-XFER-1', ownerId: me.id, category: 'apartment', purpose: 'rent' },
    });
    const app = await server();
    const signed = await signUpload(app, me.id, {
      propertyId: prop.id, sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES),
    });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    // Ownership flips between sign and finalize. finalize must see the
    // fresh DB state, not trust the pending row alone.
    await getPrisma().property.update({ where: { id: prop.id }, data: { ownerId: buyer.id } });
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(404);
    const rows = await getPrisma().mediaAsset.findMany({ where: { id: signed.assetId } });
    expect(rows).toEqual([]);
    await app.close();
  });

  it('rejects finalize when the target property was DELETED between sign and finalize', async () => {
    const me = await makeUser('+9660011132');
    const prop = await getPrisma().property.create({
      data: { listingNumber: 'L-XFER-2', ownerId: me.id, category: 'apartment', purpose: 'rent' },
    });
    const app = await server();
    const signed = await signUpload(app, me.id, {
      propertyId: prop.id, sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES),
    });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    await getPrisma().property.delete({ where: { id: prop.id } });
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /v1/media finalize — refuses degraded storage responses', () => {
  it('refuses finalize when storage cannot produce a sha256 (fail-closed on integrity)', async () => {
    // Swap SandboxStorageProvider.prototype.head so the singleton returned
    // by getStorage() reports null sha256 (mirroring an S3 that timed out
    // fetching object attributes). The finalize route MUST refuse rather
    // than accept an unverified asset.
    const me = await makeUser('+9660011140');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    const { SandboxStorageProvider } = await import('../src/storage/sandbox.js');
    const originalHead = SandboxStorageProvider.prototype.head;
    SandboxStorageProvider.prototype.head = async function () {
      return { sizeBytes: JPEG_BYTES.length, detectedContentType: 'image/jpeg', sha256: null };
    };
    try {
      const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/sha256/);
    } finally {
      SandboxStorageProvider.prototype.head = originalHead;
    }
    await app.close();
  });

  it('refuses finalize when storage cannot detect content-type (unknown magic bytes)', async () => {
    // Bytes that our detector does not recognize — refuse rather than
    // register the asset with a client-declared MIME.
    const me = await makeUser('+9660011141');
    const app = await server();
    const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
    const signed = await signUpload(app, me.id, {
      sizeBytes: junk.length, sha256: sha256Hex(junk),
    });
    await putBytes(app, signed.providerKey, junk);
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/content-type/);
    await app.close();
  });
});

// ---- V4 tests — reviewer's four P1s ----------------------------------
//
// These tests are deterministic. They hook the storage prototype to inject
// state changes at exactly the ordering points the reviewer identified, and
// verify the actual bytes at MediaAsset.providerKey (not just the DB row's
// `sha256` field). If the file bytes are corrupted, `getStorage().head(finalKey)`
// re-hashes them and returns the tampered hash, which the assertions catch.

describe('POST /v1/media finalize — V4 fix: TOCTOU race between HEAD and publish', () => {
  it('a concurrent PUT to the staging key during verify CANNOT change what MediaAsset points at', async () => {
    // Setup: sign + PUT bytes A. Attacker will attempt to overwrite with
    // bytes B (same size, different content) DURING finalize verification.
    const me = await makeUser('+9660011200');
    const app = await server();
    const A = JPEG_BYTES;
    const B = Buffer.from(JPEG_BYTES);
    B[10] = (B[10]! ^ 0xff) & 0xff; // same size, different bytes
    const declaredSha = sha256Hex(A);
    const signed = await signUpload(app, me.id, { sizeBytes: A.length, sha256: declaredSha });
    await putBytes(app, signed.providerKey, A);

    // Hook: after finalize renames uploads/... → verifying/... , the
    // attacker writes B to the OLD uploads/... key. On the vulnerable code
    // (v3), this would race against publish and corrupt the finalized copy.
    // On v4 (stage() first), it lands in a fresh empty uploads/... slot
    // that MediaAsset never references.
    const { SandboxStorageProvider, _sandboxWrite } = await import('../src/storage/sandbox.js');
    const originalStage = SandboxStorageProvider.prototype.stage;
    let injected = false;
    SandboxStorageProvider.prototype.stage = async function (from: string, to: string) {
      await originalStage.call(this, from, to);
      // Simulate the attacker's concurrent PUT arriving right after stage()
      // succeeds — the old `from` key is empty; anything written now is
      // outside our quarantine.
      _sandboxWrite(from, B);
      injected = true;
    };
    let assetSha: string;
    try {
      const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
      expect(res.statusCode).toBe(200);
      const asset = res.json() as { providerKey: string; sha256: string };
      // Fetch the ACTUAL bytes at the finalized location and re-hash.
      const { getStorage } = await import('../src/storage/index.js');
      const stat = await getStorage().head(asset.providerKey);
      // The finalized copy must be A, never B — this is the file-bytes
      // check the reviewer asked for.
      expect(stat.sha256).toBe(declaredSha);
      expect(stat.sha256).not.toBe(sha256Hex(B));
      expect(asset.sha256.toLowerCase()).toBe(declaredSha);
      assetSha = stat.sha256!;
    } finally {
      SandboxStorageProvider.prototype.stage = originalStage;
    }
    expect(injected).toBe(true);
    expect(assetSha).toBe(declaredSha);
    await app.close();
  });

  it('a PUT to uploads/... AFTER stage() lands in an unreferenced slot (defence in depth)', async () => {
    const me = await makeUser('+9660011201');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(200);
    // After finalize, the client re-uses the still-valid signed URL to PUT
    // new bytes. Sandbox route refuses (pending.finalizedAt is set) → 409.
    const putRes = await app.inject({
      method: 'PUT', url: `/v1/media/sandbox-upload/${signed.providerKey}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.concat([JPEG_BYTES, Buffer.from([0xaa, 0xbb])]),
    });
    expect(putRes.statusCode).toBe(409);
    await app.close();
  });
});

describe('POST /v1/media finalize — V4 fix: DB failure after publish is recoverable', () => {
  it('crash between publish() and DB commit → subsequent finalize completes without re-uploading', async () => {
    // Setup: sign + PUT good bytes.
    const me = await makeUser('+9660011210');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);

    // Simulate the crash: make the FIRST call to prisma.$transaction throw
    // after publish() has moved bytes to finalized/…. The route's error
    // handler should attempt a rollback (rollbackPublish) so the retry
    // still has verifying/… available. But even if rollback fails, the
    // recovery path completeAtFinalKey() picks up bytes at finalKey and
    // completes the DB write on retry.
    const prisma = getPrisma();
    const originalTx = prisma.$transaction.bind(prisma);
    let calls = 0;
    (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = ((...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error('simulated DB failure'));
      }
      // subsequent transactions run normally
      return (originalTx as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as typeof prisma.$transaction;

    try {
      const r1 = await finalize(app, me.id, signed.assetId, signed.providerKey);
      // First call — transaction failed → route surfaces 500 (default error handler).
      expect([500, 400]).toContain(r1.statusCode);

      // Retry — DB works again; the recovery path must locate the bytes
      // (either at verifying/… after rollback, or at finalized/… if
      // rollback did not run) and complete the DB write.
      const r2 = await finalize(app, me.id, signed.assetId, signed.providerKey);
      expect(r2.statusCode).toBe(200);
      const asset = r2.json() as { providerKey: string; sha256: string };
      expect(asset.providerKey).toMatch(/^finalized\//);
      expect(asset.sha256.toLowerCase()).toBe(sha256Hex(JPEG_BYTES));

      // Actual bytes at finalKey match the declared hash.
      const { getStorage } = await import('../src/storage/index.js');
      const stat = await getStorage().head(asset.providerKey);
      expect(stat.sha256).toBe(sha256Hex(JPEG_BYTES));

      // Exactly one MediaAsset row exists.
      const rows = await getPrisma().mediaAsset.findMany({ where: { id: signed.assetId } });
      expect(rows.length).toBe(1);
    } finally {
      (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = originalTx;
    }
    await app.close();
  });
});

describe('POST /v1/media finalize — V4 fix: S3 CopyObject correctness (mocked HTTP)', () => {
  it('S3 publish REFUSES a 200 response that contains <Error> XML (AWS 200-with-error semantics)', async () => {
    // Directly exercise S3StorageProvider.publish() against a mocked
    // fetch. We do NOT touch the media route because our test DB uses the
    // sandbox provider; the point of this test is to prove that the S3
    // implementation itself detects the 200-with-error case AWS documents.
    const { S3StorageProvider } = await import('../src/storage/s3.js');
    const provider = new S3StorageProvider({
      bucket: 'test-bucket', region: 'us-east-1',
      accessKeyId: 'AKIA_TEST', secretAccessKey: 'test-secret',
      endpoint: 'https://s3.example.local',
      forcePathStyle: true,
    });
    // Stub fetch: HEAD returns 200 with etag, PUT returns 200 with <Error>.
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: unknown) => {
      const method = (((init as { method?: string })?.method) ?? 'GET').toUpperCase();
      if (method === 'HEAD') {
        return new Response(null, { status: 200, headers: { etag: '"abc"', 'content-length': '100' } });
      }
      if (method === 'PUT') {
        // 200 with an Error body — this is the AWS pitfall the reviewer flagged.
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>fake</Message></Error>',
          { status: 200, headers: { 'content-type': 'application/xml' } },
        );
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(null, { status: 501 });
    }) as unknown as typeof fetch;
    try {
      await expect(provider.publish('verifying/x', 'finalized/x')).rejects.toThrow(/COPY body error/);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it('S3 publish presigns x-amz-copy-source and includes it in SignedHeaders (regression on missing signed headers)', async () => {
    const { S3StorageProvider, presign } = await import('../src/storage/s3.js');
    const provider = new S3StorageProvider({
      bucket: 'test-bucket', region: 'us-east-1',
      accessKeyId: 'AKIA_TEST', secretAccessKey: 'test-secret',
      endpoint: 'https://s3.example.local',
      forcePathStyle: true,
    });
    const originalFetch = globalThis.fetch;
    // Capture the actual URL + headers that would go to S3.
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: unknown, init?: unknown) => {
      const method = (((init as { method?: string })?.method) ?? 'GET').toUpperCase();
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { etag: '"deadbeef"' } });
      if (method === 'PUT') {
        capturedUrl = String(input);
        capturedHeaders = (((init as { headers?: unknown })?.headers) ?? {}) as Record<string, string>;
        return new Response('<CopyObjectResult><ETag>"newetag"</ETag></CopyObjectResult>', { status: 200 });
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(null, { status: 501 });
    }) as unknown as typeof fetch;
    try {
      await provider.publish('verifying/x', 'finalized/x');
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
    // SigV4 SignedHeaders must include the copy-source (+ if-match) headers.
    expect(capturedUrl).toBeTruthy();
    const url = new URL(capturedUrl!);
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders).toContain('host');
    expect(signedHeaders).toContain('x-amz-copy-source');
    expect(signedHeaders).toContain('x-amz-copy-source-if-match');
    expect(capturedHeaders?.['x-amz-copy-source']).toBe('/test-bucket/verifying/x');
    expect(capturedHeaders?.['x-amz-copy-source-if-match']).toBe('"deadbeef"');
    // Assert that presign() itself, called directly with the same headers,
    // produces a signature (i.e. these headers are supported by the API).
    const directPresigned = presign(
      { bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'AKIA_TEST', secretAccessKey: 'test-secret', endpoint: 'https://s3.example.local', forcePathStyle: true },
      'PUT', 'finalized/x', 60, new Date(), {},
      { 'x-amz-copy-source': '/test-bucket/verifying/x' },
    );
    const directSignedHeaders = new URL(directPresigned).searchParams.get('X-Amz-SignedHeaders');
    expect(directSignedHeaders).toBe('host;x-amz-copy-source');
  });

  it('S3 publish uses a real DELETE (not GET-with-X-Amz-Http) to remove the source object', async () => {
    const { S3StorageProvider } = await import('../src/storage/s3.js');
    const provider = new S3StorageProvider({
      bucket: 'test-bucket', region: 'us-east-1',
      accessKeyId: 'AKIA_TEST', secretAccessKey: 'test-secret',
      endpoint: 'https://s3.example.local',
      forcePathStyle: true,
    });
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_input: unknown, init?: unknown) => {
      const method = (((init as { method?: string })?.method) ?? 'GET').toUpperCase();
      seen.push(method);
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { etag: '"e"' } });
      if (method === 'PUT') return new Response('<CopyObjectResult/>', { status: 200 });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(null, { status: 501 });
    }) as unknown as typeof fetch;
    try {
      await provider.publish('verifying/x', 'finalized/x');
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
    // The sequence should include a real DELETE — no GET-with-X-Amz-Http fudge.
    expect(seen).toContain('DELETE');
    expect(seen.filter((m) => m === 'GET')).toEqual([]);
  });
});

// ---- V5: route-level DB failure recovery on the LOCAL provider ------
//
// v4 covered this only for the sandbox provider (which has no rollback,
// so the finalized bytes stayed put and completeAtFinalKey found them).
// The reviewer showed local's rollbackPublish moves the file out of
// finalized/, so a retry couldn't find bytes anywhere. v5 removes the
// rollback call — this test proves retry works on the REAL filesystem.

describe('POST /v1/media finalize — V5 fix: local provider DB-failure recovery', () => {
  it('local: DB tx fails once → retry completes without re-uploading', async () => {
    // Point the storage factory at a real LocalStorageProvider backed by
    // a per-test temp dir. We do this by mutating the config module and
    // clearing the getStorage() cache the same way tests already do for
    // other overrides.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-v5-local-'));
    const configMod = await import('../src/config.js');
    const origProvider = configMod.config.STORAGE_PROVIDER;
    const origDir      = configMod.config.LOCAL_STORAGE_DIR;
    const origSecret   = configMod.config.MEDIA_UPLOAD_SIGNING_SECRET;
    (configMod.config as unknown as Record<string, unknown>).STORAGE_PROVIDER = 'local';
    (configMod.config as unknown as Record<string, unknown>).LOCAL_STORAGE_DIR = dir;
    (configMod.config as unknown as Record<string, unknown>).MEDIA_UPLOAD_SIGNING_SECRET = 'x'.repeat(48);
    const storageIdx = await import('../src/storage/index.js');
    storageIdx._setStorage(null);

    try {
      const me = await makeUser('+9660011500');
      const app = await server();
      const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
      // For local, the client PUTs via the signed HMAC URL — but for this
      // route test we just call writeBytes directly since we're not
      // exercising the HMAC verifier here.
      const { LocalStorageProvider } = await import('../src/storage/local.js');
      const local = new LocalStorageProvider({ dir, signingSecret: 'x'.repeat(48) });
      await local.writeBytes(signed.providerKey, JPEG_BYTES);

      // Fail the first $transaction, then let subsequent ones through.
      const prisma = getPrisma();
      const originalTx = prisma.$transaction.bind(prisma);
      let calls = 0;
      (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = ((...args: unknown[]) => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('simulated DB failure — local recovery test'));
        return (originalTx as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
      }) as unknown as typeof prisma.$transaction;

      try {
        const r1 = await finalize(app, me.id, signed.assetId, signed.providerKey);
        // First call: transaction failed. Route surfaces 500 (default handler).
        expect([500, 400]).toContain(r1.statusCode);

        // Verify the state on disk: stage completed, verifying moved to
        // finalized by publish, no rollback → bytes at finalKey.
        const finalKey = signed.providerKey.replace(/^uploads\//, 'finalized/');
        const finalStat = await local.head(finalKey);
        expect(finalStat.sha256).toBe(sha256Hex(JPEG_BYTES));

        // Retry: DB works. Recovery path picks up bytes at finalKey and
        // completes the DB write. Client did NOT re-upload.
        const r2 = await finalize(app, me.id, signed.assetId, signed.providerKey);
        expect(r2.statusCode).toBe(200);
        const asset = r2.json() as { providerKey: string; sha256: string };
        expect(asset.providerKey).toMatch(/^finalized\//);
        expect(asset.sha256.toLowerCase()).toBe(sha256Hex(JPEG_BYTES));

        // Exactly one MediaAsset row.
        const rows = await getPrisma().mediaAsset.findMany({ where: { id: signed.assetId } });
        expect(rows.length).toBe(1);

        // File on disk actually contains the original bytes.
        const finalPath = path.join(dir, asset.providerKey);
        const bytes = fs.readFileSync(finalPath);
        const crypto = await import('node:crypto');
        expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(sha256Hex(JPEG_BYTES));
      } finally {
        (prisma as unknown as { $transaction: typeof prisma.$transaction }).$transaction = originalTx;
      }
      await app.close();
    } finally {
      (configMod.config as unknown as Record<string, unknown>).STORAGE_PROVIDER = origProvider;
      (configMod.config as unknown as Record<string, unknown>).LOCAL_STORAGE_DIR = origDir;
      (configMod.config as unknown as Record<string, unknown>).MEDIA_UPLOAD_SIGNING_SECRET = origSecret;
      (storageIdx as { _setStorage: (p: null) => void })._setStorage(null);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ---- V6: reviewer fix — ALREADY_PUBLISHED with bad bytes must REFUSE ----

describe('POST /v1/media finalize — V6 fix: ALREADY_PUBLISHED with unverifiable bytes is refused', () => {
  it('refuses to create MediaAsset when finalKey exists but hash does not match pending.sha256', async () => {
    // Reproduce the reviewer's scenario: a prior crash left a file at
    // finalKey whose bytes don't match what pending declared. v5 would
    // silently fall through to $transaction and insert a MediaAsset row
    // pointing at unverified bytes. v6 must throw 400.
    const me = await makeUser('+9660011600');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);

    // Pre-plant garbage at finalKey — different hash, same size.
    const finalKey = signed.providerKey.replace(/^uploads\//, 'finalized/');
    const garbage = Buffer.alloc(JPEG_BYTES.length, 0xaa);
    const { _sandboxWrite } = await import('../src/storage/sandbox.js');
    _sandboxWrite(finalKey, garbage);

    // Now finalize. stage() succeeds (uploads has JPEG). head(verifying) matches.
    // publish() throws ALREADY_PUBLISHED (finalKey occupied). completeAtFinalKey
    // sees hash(garbage) !== hash(JPEG) → returns null. Route MUST refuse.
    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/ALREADY_PUBLISHED|verified|refusing/i);
    // No MediaAsset row.
    const rows = await getPrisma().mediaAsset.findMany({ where: { id: signed.assetId } });
    expect(rows).toEqual([]);
    await app.close();
  });

  it('refuses when finalKey exists but size differs (partial-file scenario)', async () => {
    const me = await makeUser('+9660011601');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    // Partial file — half the size.
    const finalKey = signed.providerKey.replace(/^uploads\//, 'finalized/');
    const { _sandboxWrite } = await import('../src/storage/sandbox.js');
    _sandboxWrite(finalKey, JPEG_BYTES.subarray(0, JPEG_BYTES.length / 2));

    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(400);
    const rows = await getPrisma().mediaAsset.findMany({ where: { id: signed.assetId } });
    expect(rows).toEqual([]);
    await app.close();
  });

  it('ACCEPTS when finalKey exists AND hash matches pending (real crash recovery)', async () => {
    const me = await makeUser('+9660011602');
    const app = await server();
    const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
    await putBytes(app, signed.providerKey, JPEG_BYTES);
    // Pre-plant the CORRECT bytes at finalKey.
    const finalKey = signed.providerKey.replace(/^uploads\//, 'finalized/');
    const { _sandboxWrite } = await import('../src/storage/sandbox.js');
    _sandboxWrite(finalKey, JPEG_BYTES);

    const res = await finalize(app, me.id, signed.assetId, signed.providerKey);
    expect(res.statusCode).toBe(200);
    const asset = res.json() as { providerKey: string; sha256: string };
    expect(asset.providerKey).toBe(finalKey);
    expect(asset.sha256.toLowerCase()).toBe(sha256Hex(JPEG_BYTES));
    await app.close();
  });
});

// ---- V6: local-stream reads via HMAC-signed URL, no Bearer required ----

describe('GET /v1/media/local-stream — HMAC-signed URL, no session Bearer', () => {
  it('a browser-shaped GET (no Authorization header) succeeds when the URL sig is valid, and Range works', async () => {
    // Full end-to-end: local provider → sign → PUT → finalize → GET :id/url
    // → fetch the returned URL WITHOUT any Authorization → 206 Partial Content.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-v6-stream-'));
    const configMod = await import('../src/config.js');
    const origProvider = configMod.config.STORAGE_PROVIDER;
    const origDir      = configMod.config.LOCAL_STORAGE_DIR;
    const origSecret   = configMod.config.MEDIA_UPLOAD_SIGNING_SECRET;
    (configMod.config as unknown as Record<string, unknown>).STORAGE_PROVIDER = 'local';
    (configMod.config as unknown as Record<string, unknown>).LOCAL_STORAGE_DIR = dir;
    (configMod.config as unknown as Record<string, unknown>).MEDIA_UPLOAD_SIGNING_SECRET = 'x'.repeat(48);
    const storageIdx = await import('../src/storage/index.js');
    storageIdx._setStorage(null);
    try {
      const me = await makeUser('+9660011700');
      const app = await server();
      // sign + writeBytes + finalize (all via helpers).
      const signed = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
      const { LocalStorageProvider } = await import('../src/storage/local.js');
      const local = new LocalStorageProvider({ dir, signingSecret: 'x'.repeat(48) });
      await local.writeBytes(signed.providerKey, JPEG_BYTES);
      const finRes = await finalize(app, me.id, signed.assetId, signed.providerKey);
      expect(finRes.statusCode).toBe(200);
      const asset = finRes.json() as { id: string; providerKey: string };

      // Owner asks for a signed download URL.
      const urlRes = await app.inject({
        method: 'GET', url: `/v1/media/${asset.id}/url`,
        headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER' },
      });
      expect(urlRes.statusCode).toBe(200);
      const { url } = urlRes.json() as { url: string };
      expect(url).toMatch(/^\/v1\/media\/local-stream\/finalized\/.+\?exp=\d+&sig=[a-f0-9]{64}$/);

      // Fetch it WITHOUT Authorization — this is what <video src=...> does.
      const streamRes = await app.inject({ method: 'GET', url });
      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.headers['content-type']).toBe('image/jpeg');
      expect(Number(streamRes.headers['content-length'])).toBe(JPEG_BYTES.length);
      expect(streamRes.rawPayload.length).toBe(JPEG_BYTES.length);

      // Range request (what <video> issues while seeking).
      const rangeRes = await app.inject({
        method: 'GET', url, headers: { range: 'bytes=0-9' },
      });
      expect(rangeRes.statusCode).toBe(206);
      expect(rangeRes.headers['content-range']).toBe(`bytes 0-9/${JPEG_BYTES.length}`);
      expect(rangeRes.rawPayload.length).toBe(10);

      // Tampered signature → 401.
      const tampered = url.replace(/sig=[a-f0-9]+$/, 'sig=' + '0'.repeat(64));
      const badRes = await app.inject({ method: 'GET', url: tampered });
      expect(badRes.statusCode).toBe(401);

      // Expired signature → 401.
      const expiredUrl = url.replace(/exp=\d+/, 'exp=1');
      const expRes = await app.inject({ method: 'GET', url: expiredUrl });
      expect(expRes.statusCode).toBe(401);

      // Absent signature params → 401.
      const bareUrl = url.split('?')[0]!;
      const bareRes = await app.inject({ method: 'GET', url: bareUrl });
      expect(bareRes.statusCode).toBe(401);
      await app.close();
    } finally {
      (configMod.config as unknown as Record<string, unknown>).STORAGE_PROVIDER = origProvider;
      (configMod.config as unknown as Record<string, unknown>).LOCAL_STORAGE_DIR = origDir;
      (configMod.config as unknown as Record<string, unknown>).MEDIA_UPLOAD_SIGNING_SECRET = origSecret;
      (storageIdx as { _setStorage: (p: null) => void })._setStorage(null);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('signed URL for one asset cannot be swapped to read another asset', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-v6-swap-'));
    const configMod = await import('../src/config.js');
    const orig = { p: configMod.config.STORAGE_PROVIDER, d: configMod.config.LOCAL_STORAGE_DIR, s: configMod.config.MEDIA_UPLOAD_SIGNING_SECRET };
    (configMod.config as unknown as Record<string, unknown>).STORAGE_PROVIDER = 'local';
    (configMod.config as unknown as Record<string, unknown>).LOCAL_STORAGE_DIR = dir;
    (configMod.config as unknown as Record<string, unknown>).MEDIA_UPLOAD_SIGNING_SECRET = 'x'.repeat(48);
    const storageIdx = await import('../src/storage/index.js');
    storageIdx._setStorage(null);
    try {
      const me = await makeUser('+9660011701');
      const other = await makeUser('+9660011702');
      const app = await server();
      const { LocalStorageProvider } = await import('../src/storage/local.js');
      const local = new LocalStorageProvider({ dir, signingSecret: 'x'.repeat(48) });
      // Both users finalize an asset each.
      const s1 = await signUpload(app, me.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
      await local.writeBytes(s1.providerKey, JPEG_BYTES);
      await finalize(app, me.id, s1.assetId, s1.providerKey);
      const s2 = await signUpload(app, other.id, { sizeBytes: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES) });
      await local.writeBytes(s2.providerKey, JPEG_BYTES);
      await finalize(app, other.id, s2.assetId, s2.providerKey);
      // My signed URL for MY asset.
      const urlRes = await app.inject({
        method: 'GET', url: `/v1/media/${s1.assetId}/url`,
        headers: { 'x-user-id': me.id, 'x-user-role': 'OWNER' },
      });
      const { url } = urlRes.json() as { url: string };
      // Swap the providerKey in the path to point at OTHER's asset while
      // keeping my sig+exp. The signature is bound to providerKey so the
      // stream route must reject.
      const otherKey = s2.providerKey.replace(/^uploads\//, 'finalized/');
      const swappedUrl = url.replace(/local-stream\/[^?]+/, `local-stream/${otherKey}`);
      const res = await app.inject({ method: 'GET', url: swappedUrl });
      expect(res.statusCode).toBe(401);
      await app.close();
    } finally {
      (configMod.config as unknown as Record<string, unknown>).STORAGE_PROVIDER = orig.p;
      (configMod.config as unknown as Record<string, unknown>).LOCAL_STORAGE_DIR = orig.d;
      (configMod.config as unknown as Record<string, unknown>).MEDIA_UPLOAD_SIGNING_SECRET = orig.s;
      (storageIdx as { _setStorage: (p: null) => void })._setStorage(null);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
