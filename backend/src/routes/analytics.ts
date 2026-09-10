/**
 * POST /v1/analytics/events — record a single user interaction event.
 *
 * Contract:
 *   - Client sends { eventType, propertyId?, city?, district?, propertyType?,
 *                    purpose?, priceHalalahs?, metadata?, anonymousSessionId? }
 *   - userId is NEVER accepted from the body — it comes from the auth
 *     context if a Bearer token / dev-header is present. Otherwise the
 *     event is recorded against `anonymousSessionId` (opaque, client-supplied).
 *   - Anti-inflation: an authenticated user cannot log > 1 PROPERTY_VIEW
 *     for the same property within a 60-second sliding window (soft limit).
 *   - Feature flag `ANALYTICS_EVENTS_ENABLED` gates the endpoint entirely.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getPrisma } from '../db.js';
import { getCaller } from '../auth/rbac.js';
import { badRequest } from '../errors.js';
import { EVENT_TYPES, sanitizeMetadata, type EventType } from '../recommendation/events.js';

const bodySchema = z.object({
  eventType: z.enum(EVENT_TYPES as unknown as [EventType, ...EventType[]]),
  propertyId: z.string().min(1).max(40).optional(),
  city: z.string().min(1).max(80).optional(),
  district: z.string().min(1).max(120).optional(),
  propertyType: z.string().min(1).max(40).optional(),
  purpose: z.string().min(1).max(40).optional(),
  priceHalalahs: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  anonymousSessionId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_\-]+$/).optional(),
});

const DEDUP_WINDOW_MS = 60_000;

export default async function analyticsRoutes(app: FastifyInstance) {
  app.post('/v1/analytics/events', async (req, reply) => {
    if (!config.ANALYTICS_EVENTS_ENABLED) {
      return reply.code(503).send({ error: 'FEATURE_DISABLED', message: 'analytics events disabled' });
    }

    const caller = getCaller(req);
    const body = bodySchema.parse(req.body);
    const userId = caller?.userId ?? null;
    // Enforce presence of one identity signal — no fully-orphan events.
    const anonymousSessionId = userId ? null : body.anonymousSessionId ?? null;
    if (!userId && !anonymousSessionId) {
      throw badRequest('anonymousSessionId required for unauthenticated events');
    }

    const priceHalalahs = body.priceHalalahs !== undefined
      ? BigInt(body.priceHalalahs)
      : null;
    const metadata = JSON.stringify(sanitizeMetadata(body.metadata));

    const prisma = getPrisma();

    // Anti-manipulation: for authenticated users, drop a repeated
    // PROPERTY_VIEW on the same property within 60s. Cheap and effective
    // against F5-spam / auto-refresh loops boosting rank.
    if (userId && body.propertyId && body.eventType === 'PROPERTY_VIEW') {
      const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
      const dupe = await prisma.userEvent.findFirst({
        where: {
          userId,
          propertyId: body.propertyId,
          eventType: 'PROPERTY_VIEW',
          createdAt: { gt: cutoff },
        },
        select: { id: true },
      });
      if (dupe) return { ok: true, deduplicated: true };
    }

    await prisma.userEvent.create({
      data: {
        userId,
        anonymousSessionId,
        eventType: body.eventType,
        propertyId: body.propertyId ?? null,
        city: body.city ?? null,
        district: body.district ?? null,
        propertyType: body.propertyType ?? null,
        purpose: body.purpose ?? null,
        priceHalalahs,
        metadata,
      },
    });

    return { ok: true };
  });
}
