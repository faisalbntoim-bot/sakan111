/**
 * POST /v1/events — internal event tracking ingestion (v1).
 *
 * Contract:
 *   - `eventName` MUST be one of TRACKABLE_EVENTS. Anything else is
 *     dropped silently (still 204) so a client typo doesn't burn a
 *     retry.
 *   - `userId` is NEVER accepted from the body — pulled from the auth
 *     context. Unauthenticated callers may pass an opaque `sessionId`.
 *   - Feature-flag `EVENT_TRACKING_ENABLED`: when off, endpoint is a
 *     safe no-op returning 204 (so the frontend can call this before
 *     the flag is flipped without generating errors).
 *   - Fastify's global body limit + rate limit already apply.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getCaller } from '../auth/rbac.js';
import { trackEvent } from '../analytics/event-tracking-service.js';
import { TRACKABLE_EVENTS, EVENT_LIMITS, type TrackableEvent } from '../analytics/event-types.js';

const bodySchema = z.object({
  eventName: z.enum(TRACKABLE_EVENTS as unknown as [TrackableEvent, ...TrackableEvent[]]),
  sessionId: z.string().min(4).max(EVENT_LIMITS.sessionIdMax).regex(/^[A-Za-z0-9_\-]+$/).optional(),
  propertyId: z.string().min(1).max(EVENT_LIMITS.propertyIdMax).optional(),
  city: z.string().min(1).max(EVENT_LIMITS.cityMax).optional(),
  district: z.string().min(1).max(EVENT_LIMITS.districtMax).optional(),
  propertyType: z.string().min(1).max(EVENT_LIMITS.propertyTypeMax).optional(),
  listingType: z.string().min(1).max(EVENT_LIMITS.listingTypeMax).optional(),
  searchQuery: z.string().max(EVENT_LIMITS.searchQueryMax).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export default async function eventRoutes(app: FastifyInstance) {
  app.post('/v1/events', async (req, reply) => {
    // Even when the flag is off we accept + no-op — this lets the web
    // client fire tracking blindly during the flag rollout without
    // seeing 4xx/5xx in the console.
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(req.body);
    } catch {
      // Bad payload — still return 204 rather than 400 so analytics
      // never surfaces user-facing errors, but do nothing.
      return reply.code(204).send();
    }
    const caller = getCaller(req);
    // Server-derived identity — client cannot spoof userId.
    // Awaited so the response only returns after the insert completes:
    // trackEvent never throws (best-effort) and the insert is a single
    // tiny INSERT so the request stays fast + ordered.
    await trackEvent({
      eventName: body.eventName,
      userId: caller?.userId ?? null,
      sessionId: caller ? null : body.sessionId ?? null,
      propertyId: body.propertyId,
      city: body.city,
      district: body.district,
      propertyType: body.propertyType,
      listingType: body.listingType,
      searchQuery: body.searchQuery,
      metadata: body.metadata ?? null,
    });
    return reply.code(204).send();
  });
}
