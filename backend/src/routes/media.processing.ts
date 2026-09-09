/**
 * Media processing job routes — "ادخل العقار" (Enter Property) subsystem.
 *
 * Feature-flag gated: every route here 404s if PROPERTY_3D_CAPTURE_ENABLED
 * is false. All writes verify caller owns the referenced MediaAsset(s),
 * or is an admin.
 *
 * ⚠️  Submitting a gaussian_splat job does NOT run any real processing.
 *     The default `UnavailableGaussianSplatProcessor` returns
 *     `not_available` with a message, and the job is persisted with
 *     `processingStatus = 'failed'` so clients see the honest state.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db.js';
import { requireAuth, isAdminRole } from '../auth/rbac.js';
import { badRequest, notFound, forbidden } from '../errors.js';
import { featureFlags } from '../config/feature-flags.js';
import { getGaussianSplatProcessor } from '../media/processors/gaussian-splat.interface.js';
import { jsonSafe } from '../money.js';

const UPLOAD_STATES = ['pending', 'uploading', 'uploaded', 'failed'] as const;
const PROCESSING_STATES = ['not_requested', 'queued', 'processing', 'ready', 'failed', 'archived'] as const;
const JOB_TYPES = ['gaussian_splat', 'panorama_stitch', 'thumbnail', 'ai_tour'] as const;

const createSchema = z.object({
  mediaAssetIds: z.array(z.string().min(1)).min(1).max(200),
  jobType: z.enum(JOB_TYPES),
});

const patchSchema = z.object({
  uploadStatus:     z.enum(UPLOAD_STATES).optional(),
  processingStatus: z.enum(PROCESSING_STATES).optional(),
  errorMessage:     z.string().max(2000).optional(),
});

function requireFlag() {
  if (!featureFlags.PROPERTY_3D_CAPTURE_ENABLED) {
    throw notFound('media processing not enabled');
  }
}

export default async function mediaProcessingRoutes(app: FastifyInstance) {
  /** Create a processing job — caller must own EVERY referenced MediaAsset. */
  app.post('/v1/media/processing-jobs', async (req, reply) => {
    requireFlag();
    const caller = requireAuth(req, reply);
    const body = createSchema.parse(req.body);
    const prisma = getPrisma();

    const assets = await prisma.mediaAsset.findMany({
      where: { id: { in: body.mediaAssetIds } },
    });
    if (assets.length !== body.mediaAssetIds.length) {
      throw badRequest('one or more mediaAssetIds not found', {
        expected: body.mediaAssetIds.length, found: assets.length,
      });
    }
    for (const a of assets) {
      if (a.ownerUserId !== caller.userId && !isAdminRole(caller.role)) {
        throw forbidden('you do not own this media asset');
      }
    }

    // Anchor the job on the first asset. For multi-input jobs (e.g. splat
    // from a photo burst) the additional assets are tracked by the
    // processor via `providerJobId`; there is no MediaProcessingJobAsset
    // join table in the MVP schema — kept intentionally small.
    const anchor = assets[0]!;
    const job = await prisma.mediaProcessingJob.create({
      data: {
        mediaAssetId:     anchor.id,
        ownerUserId:      caller.userId,
        jobType:          body.jobType,
        uploadStatus:     'uploaded',       // assets already exist so upload is done
        processingStatus: 'queued',
      },
    });

    if (body.jobType === 'gaussian_splat') {
      const proc = getGaussianSplatProcessor();
      const result = await proc.submit({
        ownerUserId:  caller.userId,
        mediaAssetIds: body.mediaAssetIds,
      });
      // Honestly reflect the provider's state — never fake "ready".
      const nextProcessing = result.state === 'not_available' ? 'failed' : result.state;
      const updated = await prisma.mediaProcessingJob.update({
        where: { id: job.id },
        data: {
          providerJobId:    result.providerJobId,
          processingStatus: nextProcessing,
          errorMessage:     result.message ?? null,
        },
      });
      return reply.code(201).send(jsonSafe(updated));
    }

    return reply.code(201).send(jsonSafe(job));
  });

  /** Read a single job — owner or admin. */
  app.get('/v1/media/processing-jobs/:id', async (req, reply) => {
    requireFlag();
    const caller = requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const job = await getPrisma().mediaProcessingJob.findUnique({ where: { id } });
    if (!job) throw notFound('processing job not found');
    if (job.ownerUserId !== caller.userId && !isAdminRole(caller.role)) {
      throw notFound('processing job not found');
    }
    return jsonSafe(job);
  });

  /** List caller's own processing jobs. */
  app.get('/v1/media/processing-jobs', async (req, reply) => {
    requireFlag();
    const caller = requireAuth(req, reply);
    const jobs = await getPrisma().mediaProcessingJob.findMany({
      where: { ownerUserId: caller.userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return jsonSafe({ items: jobs });
  });

  /**
   * PATCH — clients update upload progress; admins update processing status
   * on behalf of a real external service. Non-admin callers can only touch
   * `uploadStatus` — the processing side is server/admin authoritative.
   */
  app.patch('/v1/media/processing-jobs/:id', async (req, reply) => {
    requireFlag();
    const caller = requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);

    const prisma = getPrisma();
    const existing = await prisma.mediaProcessingJob.findUnique({ where: { id } });
    if (!existing) throw notFound('processing job not found');
    if (existing.ownerUserId !== caller.userId && !isAdminRole(caller.role)) {
      throw notFound('processing job not found');
    }
    if (body.processingStatus && !isAdminRole(caller.role)) {
      throw forbidden('only admins may set processingStatus');
    }

    const updated = await prisma.mediaProcessingJob.update({
      where: { id },
      data: {
        uploadStatus:     body.uploadStatus     ?? existing.uploadStatus,
        processingStatus: body.processingStatus ?? existing.processingStatus,
        errorMessage:     body.errorMessage     ?? existing.errorMessage,
      },
    });
    return jsonSafe(updated);
  });
}
