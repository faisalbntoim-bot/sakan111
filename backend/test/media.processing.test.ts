/**
 * Tests for /v1/media/processing-jobs — the "ادخل العقار" media pipeline.
 *
 * Covers:
 *  - feature-flag gating (404 when disabled)
 *  - ownership enforcement (403 for foreign asset)
 *  - honest 3DGS provider (failed + not_available message, never fake ready)
 *  - upload vs processing status separation (owner may not set processingStatus)
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { resetDb, shutdown, buildTestApp } from './helpers.js';
import mediaProcessingRoutes from '../src/routes/media.processing.js';
import { getPrisma } from '../src/db.js';
import { featureFlags } from '../src/config/feature-flags.js';

async function server() {
  return buildTestApp(async (app) => { await app.register(mediaProcessingRoutes); });
}

async function seedTwoUsersAndAsset() {
  const prisma = getPrisma();
  const owner = await prisma.user.create({ data: { phone: '+9661101', nameAr: 'المالك' } });
  const other = await prisma.user.create({ data: { phone: '+9661102', nameAr: 'آخر' } });
  const asset = await prisma.mediaAsset.create({
    data: {
      ownerUserId: owner.id,
      kind: 'image', provider: 'sandbox', providerKey: 'k1',
      mimeType: 'image/jpeg', sizeBytes: 1024,
      sha256: 'a'.repeat(64),
    },
  });
  return { owner, other, asset };
}

beforeEach(async () => {
  await resetDb();
  featureFlags.PROPERTY_3D_CAPTURE_ENABLED = true;
});
afterEach(() => {
  featureFlags.PROPERTY_3D_CAPTURE_ENABLED = false;
});
afterAll(async () => { await shutdown(); });

describe('feature-flag gating', () => {
  it('returns 404 when PROPERTY_3D_CAPTURE_ENABLED is off', async () => {
    featureFlags.PROPERTY_3D_CAPTURE_ENABLED = false;
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/media/processing-jobs',
      payload: { mediaAssetIds: ['x'], jobType: 'thumbnail' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': 'u', 'x-user-role': 'HOST',
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('ownership', () => {
  it('forbids creating a job on a foreign asset', async () => {
    const { other, asset } = await seedTwoUsersAndAsset();
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/media/processing-jobs',
      payload: { mediaAssetIds: [asset.id], jobType: 'thumbnail' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': other.id, 'x-user-role': 'HOST',
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets the owner create a job', async () => {
    const { owner, asset } = await seedTwoUsersAndAsset();
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/media/processing-jobs',
      payload: { mediaAssetIds: [asset.id], jobType: 'thumbnail' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': owner.id, 'x-user-role': 'HOST',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().jobType).toBe('thumbnail');
    expect(res.json().processingStatus).toBe('queued');
    await app.close();
  });
});

describe('gaussian_splat — honest provider', () => {
  it('creates the job but marks processingStatus=failed with not_available message', async () => {
    const { owner, asset } = await seedTwoUsersAndAsset();
    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/media/processing-jobs',
      payload: { mediaAssetIds: [asset.id], jobType: 'gaussian_splat' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': owner.id, 'x-user-role': 'HOST',
      },
    });
    expect(res.statusCode).toBe(201);
    const job = res.json();
    // Never claims "ready" — must be honest.
    expect(job.processingStatus).toBe('failed');
    expect(job.errorMessage).toMatch(/not configured/i);
    expect(job.providerJobId).toBeNull();
    await app.close();
  });
});

describe('upload vs processing state separation', () => {
  it('lets the owner update uploadStatus but NOT processingStatus', async () => {
    const { owner, asset } = await seedTwoUsersAndAsset();
    const app = await server();
    const created = await app.inject({
      method: 'POST', url: '/v1/media/processing-jobs',
      payload: { mediaAssetIds: [asset.id], jobType: 'thumbnail' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': owner.id, 'x-user-role': 'HOST',
      },
    });
    const jobId = created.json().id;

    const patchUpload = await app.inject({
      method: 'PATCH', url: `/v1/media/processing-jobs/${jobId}`,
      payload: { uploadStatus: 'uploaded' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': owner.id, 'x-user-role': 'HOST',
      },
    });
    expect(patchUpload.statusCode).toBe(200);
    expect(patchUpload.json().uploadStatus).toBe('uploaded');

    const patchProcessing = await app.inject({
      method: 'PATCH', url: `/v1/media/processing-jobs/${jobId}`,
      payload: { processingStatus: 'ready' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': owner.id, 'x-user-role': 'HOST',
      },
    });
    expect(patchProcessing.statusCode).toBe(403);

    // Admin may set processingStatus.
    const patchAdmin = await app.inject({
      method: 'PATCH', url: `/v1/media/processing-jobs/${jobId}`,
      payload: { processingStatus: 'ready' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': 'admin', 'x-user-role': 'ADMIN',
      },
    });
    expect(patchAdmin.statusCode).toBe(200);
    expect(patchAdmin.json().processingStatus).toBe('ready');
    await app.close();
  });
});
