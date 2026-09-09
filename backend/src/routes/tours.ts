/**
 * PropertyTour routes — "ادخل العقار" (Enter Property) subsystem.
 *
 * Ownership: writes require the caller to own the Property (or be admin).
 * Feature-flag gated by PROPERTY_3D_VIEWER_ENABLED — a disabled deployment
 * exposes nothing here.
 *
 * A tour of type `gaussian_splat` created without an associated processed
 * `primaryAssetId` cannot be `published`. This guard is explicit so we
 * never publish an empty 3D viewer.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db.js';
import { requireAuth, isAdminRole } from '../auth/rbac.js';
import { badRequest, notFound, forbidden } from '../errors.js';
import { featureFlags } from '../config/feature-flags.js';
import { jsonSafe } from '../money.js';

const TOUR_TYPES = ['panorama_360', 'gaussian_splat', 'virtual_walkthrough', 'ai_tour'] as const;
const TOUR_STATUSES = ['draft', 'processing', 'ready', 'published', 'archived'] as const;

const createSchema = z.object({
  propertyId:     z.string().min(1),
  tourType:       z.enum(TOUR_TYPES),
  primaryAssetId: z.string().optional(),
  processingJobId: z.string().optional(),
  title:          z.string().max(200).optional(),
  descriptionAr:  z.string().max(2000).optional(),
  descriptionEn:  z.string().max(2000).optional(),
});

const patchSchema = z.object({
  status:         z.enum(TOUR_STATUSES).optional(),
  primaryAssetId: z.string().optional(),
  processingJobId: z.string().optional(),
  title:          z.string().max(200).optional(),
  descriptionAr:  z.string().max(2000).optional(),
  descriptionEn:  z.string().max(2000).optional(),
});

const hotspotSchema = z.object({
  label:        z.string().min(1).max(200),
  targetTourId: z.string().optional(),
  positionJson: z.string().max(500),
});

function requireFlag() {
  if (!featureFlags.PROPERTY_3D_VIEWER_ENABLED) {
    throw notFound('property tours not enabled');
  }
}

async function assertOwnsProperty(propertyId: string, callerUserId: string, callerRole: string) {
  const prop = await getPrisma().property.findUnique({ where: { id: propertyId } });
  if (!prop) throw notFound('property not found');
  if (prop.ownerId !== callerUserId && !isAdminRole(callerRole as never)) {
    throw forbidden('you do not own this property');
  }
  return prop;
}

async function loadOwnedTour(tourId: string, callerUserId: string, callerRole: string) {
  const tour = await getPrisma().propertyTour.findUnique({ where: { id: tourId } });
  if (!tour) throw notFound('tour not found');
  if (tour.ownerUserId !== callerUserId && !isAdminRole(callerRole as never)) {
    // 404 (not 403) to avoid leaking existence.
    throw notFound('tour not found');
  }
  return tour;
}

export default async function tourRoutes(app: FastifyInstance) {
  /** Create a tour for a property the caller owns. */
  app.post('/v1/tours', async (req, reply) => {
    requireFlag();
    const caller = requireAuth(req, reply);
    const body = createSchema.parse(req.body);
    await assertOwnsProperty(body.propertyId, caller.userId, caller.role);

    // If a primaryAssetId is provided, verify caller owns it too.
    if (body.primaryAssetId) {
      const asset = await getPrisma().mediaAsset.findUnique({ where: { id: body.primaryAssetId } });
      if (!asset) throw badRequest('primaryAssetId not found');
      if (asset.ownerUserId !== caller.userId && !isAdminRole(caller.role)) {
        throw forbidden('you do not own the referenced media asset');
      }
    }

    const tour = await getPrisma().propertyTour.create({
      data: {
        propertyId:      body.propertyId,
        ownerUserId:     caller.userId,       // write-once ownership stamp
        tourType:        body.tourType,
        primaryAssetId:  body.primaryAssetId ?? null,
        processingJobId: body.processingJobId ?? null,
        title:           body.title ?? null,
        descriptionAr:   body.descriptionAr ?? null,
        descriptionEn:   body.descriptionEn ?? null,
      },
    });
    return reply.code(201).send(jsonSafe(tour));
  });

  /** List tours for a property (public: PUBLISHED only for non-owners). */
  app.get('/v1/tours', async (req, reply) => {
    requireFlag();
    const caller = requireAuth(req, reply);
    const q = z.object({ propertyId: z.string().min(1) }).parse(req.query);
    const prisma = getPrisma();
    const prop = await prisma.property.findUnique({ where: { id: q.propertyId } });
    if (!prop) throw notFound('property not found');
    const isOwner = prop.ownerId === caller.userId || isAdminRole(caller.role);
    const tours = await prisma.propertyTour.findMany({
      where: isOwner
        ? { propertyId: q.propertyId }
        : { propertyId: q.propertyId, status: 'published' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return jsonSafe({ items: tours });
  });

  /** Read one tour — visible if PUBLISHED, or if caller owns it. */
  app.get('/v1/tours/:id', async (req, reply) => {
    requireFlag();
    const caller = requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const tour = await getPrisma().propertyTour.findUnique({
      where: { id },
      include: { hotspots: true },
    });
    if (!tour) throw notFound('tour not found');
    const isOwner = tour.ownerUserId === caller.userId || isAdminRole(caller.role);
    if (!isOwner && tour.status !== 'published') throw notFound('tour not found');
    return jsonSafe(tour);
  });

  /** Patch — owner only. Publishing requires a primaryAssetId. */
  app.patch('/v1/tours/:id', async (req, reply) => {
    requireFlag();
    const caller = requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const tour = await loadOwnedTour(id, caller.userId, caller.role);

    if (body.status === 'published') {
      const finalAsset = body.primaryAssetId ?? tour.primaryAssetId;
      if (!finalAsset) throw badRequest('cannot publish a tour without a primaryAssetId');
    }
    if (body.primaryAssetId) {
      const asset = await getPrisma().mediaAsset.findUnique({ where: { id: body.primaryAssetId } });
      if (!asset) throw badRequest('primaryAssetId not found');
      if (asset.ownerUserId !== caller.userId && !isAdminRole(caller.role)) {
        throw forbidden('you do not own the referenced media asset');
      }
    }

    const updated = await getPrisma().propertyTour.update({
      where: { id },
      data: {
        status:          body.status          ?? tour.status,
        primaryAssetId:  body.primaryAssetId  ?? tour.primaryAssetId,
        processingJobId: body.processingJobId ?? tour.processingJobId,
        title:           body.title           ?? tour.title,
        descriptionAr:   body.descriptionAr   ?? tour.descriptionAr,
        descriptionEn:   body.descriptionEn   ?? tour.descriptionEn,
        publishedAt:     body.status === 'published' && !tour.publishedAt ? new Date() : tour.publishedAt,
      },
    });
    return jsonSafe(updated);
  });

  /** Add a hotspot — owner only. */
  app.post('/v1/tours/:id/hotspots', async (req, reply) => {
    requireFlag();
    const caller = requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = hotspotSchema.parse(req.body);
    await loadOwnedTour(id, caller.userId, caller.role);
    const hs = await getPrisma().tourHotspot.create({
      data: {
        tourId:       id,
        label:        body.label,
        targetTourId: body.targetTourId ?? null,
        positionJson: body.positionJson,
      },
    });
    return reply.code(201).send(jsonSafe(hs));
  });
}
