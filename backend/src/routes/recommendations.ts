/**
 * Recommendations v1 — public API.
 *
 *   GET /v1/recommendations?mode=&limit=&city=&district=&…
 *   GET /v1/properties/:id/similar?limit=
 *
 * Auth:
 *   - userId is derived from the auth context (JWT / dev header).
 *   - Anonymous callers may pass `?sessionId=` — validated shape only.
 *   - Client-supplied userId is NEVER trusted.
 *
 * Flag:
 *   - RECOMMENDATIONS_ENABLED gates personalised ranking.
 *   - When OFF, both routes still respond 200 with a safe fallback
 *     (fresh + quality) so the frontend can call blindly during
 *     rollout without console errors.
 *
 * Debug fields (`_reasons`, `_score`, `_reasonAr`) are only added
 * when NODE_ENV !== 'production'.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getCaller } from '../auth/rbac.js';
import { jsonSafe } from '../money.js';
import { getRecommendationsForUser, getSimilarPropertyRecommendations } from '../recommendations/recommendation-service.js';
import { RECOMMENDATION_MODES, type RecommendationMode } from '../recommendations/recommendation-types.js';
import { primaryReasonLabelAr } from '../recommendations/reasons-ar.js';

// Same public projection the properties route uses — never leak ownerId.
function publicProjection<T extends { ownerId?: string; officeId?: string | null }>(p: T) {
  const { ownerId: _o, officeId: _f, ...rest } = p as any;
  return rest;
}

const forYouQuery = z.object({
  mode: z.enum(RECOMMENDATION_MODES as unknown as [RecommendationMode, ...RecommendationMode[]]).default('for_you'),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  sessionId: z.string().min(4).max(128).regex(/^[A-Za-z0-9_\-]+$/).optional(),
  city: z.string().max(80).optional(),
  district: z.string().max(120).optional(),
  propertyType: z.string().max(40).optional(),
  listingType: z.string().max(40).optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
});

const similarParams = z.object({ id: z.string().min(1).max(40) });
const similarQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
  sessionId: z.string().min(4).max(128).regex(/^[A-Za-z0-9_\-]+$/).optional(),
});

export default async function recommendationRoutes(app: FastifyInstance) {
  app.get('/v1/recommendations', async (req) => {
    const q = forYouQuery.parse(req.query ?? {});
    const caller = getCaller(req);
    const { items, mode, personalized, fallback } = await getRecommendationsForUser({
      userId: caller?.userId ?? null,
      sessionId: caller ? null : q.sessionId ?? null,
      mode: q.mode,
      context: {
        city: q.city, district: q.district,
        propertyType: q.propertyType, listingType: q.listingType,
        minPrice: q.minPrice, maxPrice: q.maxPrice,
      },
      limit: q.limit,
    });
    const includeDebug = config.NODE_ENV !== 'production';
    return jsonSafe({
      mode,
      personalized,
      fallback,
      items: items.map((it) => {
        const projected = publicProjection(it.property as Record<string, unknown>);
        return includeDebug
          ? { ...projected, _score: it.score, _reasons: it.reasons, _reasonAr: primaryReasonLabelAr(it.reasons) }
          : { ...projected, reasonAr: primaryReasonLabelAr(it.reasons) };
      }),
    });
  });

  app.get('/v1/properties/:id/similar', async (req) => {
    const p = similarParams.parse(req.params ?? {});
    const q = similarQuery.parse(req.query ?? {});
    const caller = getCaller(req);
    const { items } = await getSimilarPropertyRecommendations({
      propertyId: p.id,
      userId: caller?.userId ?? null,
      sessionId: caller ? null : q.sessionId ?? null,
      limit: q.limit,
    });
    const includeDebug = config.NODE_ENV !== 'production';
    return jsonSafe({
      items: items.map((it) => {
        const projected = publicProjection(it.property as Record<string, unknown>);
        return includeDebug
          ? { ...projected, _score: it.score }
          : projected;
      }),
    });
  });
}
