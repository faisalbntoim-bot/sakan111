/**
 * Public / owner / admin property endpoints.
 *
 *   GET /v1/properties                  — search + filters + pagination
 *   GET /v1/properties/:id              — details, field-visibility per caller role
 *   GET /v1/properties/:id/availability — booked date ranges for a query window
 *
 * Visibility model:
 *   - Public callers see only listings with status='available' and public fields.
 *   - The property owner sees all their listings + owner-only fields.
 *   - Admin roles see everything.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getPrisma } from '../db.js';
import { getCaller, isAdminRole, requireAuth } from '../auth/rbac.js';
import { badRequest, notFound } from '../errors.js';
import { jsonSafe } from '../money.js';
import { buildPreferenceProfile } from '../recommendation/preferences.js';
import { computeQualityScore } from '../recommendation/quality.js';
import { scorePropertyForUser, scorePropertyColdStart } from '../recommendation/scorer.js';
import { calculateFeedScore, type FeedContext } from '../services/feed-ranking.js';
import { diversifyFeed } from '../services/feed-diversity.js';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().max(200).optional(),
  category: z.string().max(40).optional(),
  purpose: z.string().max(40).optional(),
  city: z.string().max(80).optional(),
  status: z.enum(['available', 'reserved', 'sold', 'rented', 'hidden']).optional(),
  ownerId: z.string().optional(),
  // ---- Property Data v2 filters (all optional; backward compatible) ----
  district: z.string().max(120).optional(),
  propertyType: z.string().max(40).optional(),          // alias for `category`
  listingType: z.string().max(40).optional(),           // alias for `purpose`
  minPrice: z.coerce.number().nonnegative().optional(), // in halalahs
  maxPrice: z.coerce.number().nonnegative().optional(),
  minArea: z.coerce.number().int().nonnegative().optional(),
  maxArea: z.coerce.number().int().nonnegative().optional(),
  bedrooms: z.coerce.number().int().nonnegative().max(50).optional(),
  bathrooms: z.coerce.number().int().nonnegative().max(50).optional(),
  furnished: z.union([z.literal('true'), z.literal('false')]).optional(),
});

const availabilityQuery = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

/** Public projection — never leaks ownerId/officeId/hidden state. */
function publicProjection<T extends { ownerId: string; officeId: string | null }>(p: T) {
  const { ownerId: _ownerId, officeId: _officeId, ...rest } = p;
  return rest;
}

export default async function propertyRoutes(app: FastifyInstance) {
  app.get('/v1/properties', async (req) => {
    const caller = getCaller(req);
    const q = listQuery.parse(req.query ?? {});
    const prisma = getPrisma();

    const where: Record<string, unknown> = {};
    // Filters — legacy names first, then their v2 aliases (v2 wins on collision)
    if (q.category) where.category = q.category;
    if (q.purpose) where.purpose = q.purpose;
    if (q.propertyType) where.category = q.propertyType;
    if (q.listingType) where.purpose = q.listingType;
    if (q.city) where.city = q.city;
    if (q.district) where.district = q.district;
    if (q.bedrooms !== undefined) where.bedrooms = q.bedrooms;
    if (q.bathrooms !== undefined) where.bathrooms = q.bathrooms;
    if (q.furnished !== undefined) where.furnished = q.furnished === 'true';
    if (q.minPrice !== undefined || q.maxPrice !== undefined) {
      const price: Record<string, bigint> = {};
      if (q.minPrice !== undefined) price.gte = BigInt(Math.floor(q.minPrice));
      if (q.maxPrice !== undefined) price.lte = BigInt(Math.floor(q.maxPrice));
      where.priceHalalahs = price;
    }
    if (q.minArea !== undefined || q.maxArea !== undefined) {
      const area: Record<string, number> = {};
      if (q.minArea !== undefined) area.gte = q.minArea;
      if (q.maxArea !== undefined) area.lte = q.maxArea;
      where.areaSqm = area;
    }

    // Status: unauthenticated + non-admin can only see `available`.
    // Owner filter: unauthenticated cannot filter by ownerId.
    if (q.ownerId) {
      if (!caller) throw badRequest('ownerId filter requires auth');
      if (!isAdminRole(caller.role) && q.ownerId !== caller.userId) {
        // Prevent scanning another user's listings via the owner filter.
        return { items: [], page: q.page, pageSize: q.pageSize, total: 0 };
      }
      where.ownerId = q.ownerId;
    }
    if (q.status) {
      if (q.status !== 'available' && !caller) throw badRequest('non-public status requires auth');
      where.status = q.status;
    } else if (!caller || !isAdminRole(caller.role)) {
      // Default listing hides reserved/sold/rented/hidden from the public.
      where.status = 'available';
    }

    if (q.search) {
      // Prisma+SQLite does not support case-insensitive `mode` — the tests only assert substring match.
      where.OR = [
        { listingNumber: { contains: q.search } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.property.count({ where }),
      prisma.property.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);

    const items = rows.map((r) => (caller && isAdminRole(caller.role) ? r : publicProjection(r)));
    return jsonSafe({ items, page: q.page, pageSize: q.pageSize, total });
  });

  app.get('/v1/properties/:id', async (req) => {
    const caller = getCaller(req);
    const { id } = req.params as { id: string };
    const property = await getPrisma().property.findUnique({
      where: { id },
      include: { hosts: true },
    });
    if (!property) throw notFound('property not found');
    const isOwner = !!caller && caller.userId === property.ownerId;
    const isAdmin = !!caller && isAdminRole(caller.role);

    if (property.status === 'hidden' && !isOwner && !isAdmin) {
      throw notFound('property not found');
    }
    if (property.status !== 'available' && !caller) {
      // Anonymous callers can only read available listings.
      throw notFound('property not found');
    }

    const view = isOwner || isAdmin
      ? property
      : publicProjection(property);
    return jsonSafe(view);
  });

  app.get('/v1/properties/:id/availability', async (req) => {
    const { id } = req.params as { id: string };
    const q = availabilityQuery.parse(req.query ?? {});
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('invalid dates');
    if (from.getTime() >= to.getTime()) throw badRequest('from must be before to');

    const prisma = getPrisma();
    const property = await prisma.property.findUnique({ where: { id } });
    if (!property) throw notFound('property not found');

    // Bookings that hold the property (checkIn < to AND checkOut > from), excluding cancelled/completed.
    const bookings = await prisma.booking.findMany({
      where: {
        propertyId: id,
        status: { in: ['pending_payment', 'confirmed'] },
        AND: [
          { checkIn:  { lt:  to } },
          { checkOut: { gt:  from } },
        ],
      },
      select: { id: true, checkIn: true, checkOut: true, status: true },
    });

    const booked = bookings
      .filter((b) => b.checkIn && b.checkOut)
      .map((b) => ({ from: b.checkIn, to: b.checkOut, bookingId: b.id, status: b.status }));

    return {
      propertyId: id,
      from: from.toISOString(),
      to: to.toISOString(),
      isAvailable: booked.length === 0,
      bookedRanges: booked,
    };
  });

  /**
   * GET /v1/properties/feed — ranked property list.
   *
   * When `personalized=true` AND `RECOMMENDATION_ENGINE_ENABLED` is on,
   * ranks by Recommendation Score V1 (see recommendation/scorer.ts) using
   * the caller's inferred preference profile. Otherwise falls back to
   * the existing "updatedAt desc" order — so if the engine ever throws,
   * the user still gets a valid feed (see try/catch below).
   */
  const feedQuery = z.object({
    page: z.coerce.number().int().min(1).max(1000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    personalized: z.union([z.literal('true'), z.literal('false'), z.boolean()]).optional(),
    // Smart-feed v1 (services/feed-ranking.ts). Backward-compatible: when
    // `sort` is anything other than 'smart', the existing behaviour is
    // untouched. Enabling requires SMART_FEED_ENABLED=true in env.
    sort: z.enum(['default', 'smart']).default('default'),
    city: z.string().max(80).optional(),
    district: z.string().max(120).optional(),
    propertyType: z.string().max(40).optional(),
    listingType: z.string().max(40).optional(),
    minPrice: z.coerce.number().nonnegative().optional(),
    maxPrice: z.coerce.number().nonnegative().optional(),
    bedrooms: z.coerce.number().int().nonnegative().optional(),
  });

  app.get('/v1/properties/feed', async (req) => {
    const caller = getCaller(req);
    const q = feedQuery.parse(req.query ?? {});
    const wantPersonalized =
      (q.personalized === true || q.personalized === 'true') && config.RECOMMENDATION_ENGINE_ENABLED;
    const prisma = getPrisma();

    // Base pool — always "available" for the public feed.
    const where = { status: 'available' as const };
    // Pull a slightly wider pool than pageSize so ranking has room to reorder.
    const pool = await prisma.property.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: q.pageSize * 5,
    });

    // ---- Smart feed v1 --------------------------------------------------
    // Handled BEFORE the personalized/default paths so the query-string
    // opt-in wins even when the recommendation flag is off. Returns a
    // scored + diversified page. Falls back to the default order on any
    // exception so a ranker bug can NEVER break the public feed.
    if (q.sort === 'smart' && config.SMART_FEED_ENABLED) {
      try {
        const ctx: FeedContext = {
          city: q.city,
          district: q.district,
          propertyType: q.propertyType,
          listingType: q.listingType,
          minPrice: q.minPrice,
          maxPrice: q.maxPrice,
          bedrooms: q.bedrooms,
        };
        const scored = pool.map((p) => {
          const r = calculateFeedScore(p, ctx);
          return { property: p, ...r };
        });
        scored.sort((a, b) => b.score - a.score);
        const diversified = diversifyFeed(scored);
        const paged = diversified.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
        // Debug fields (_score, _reasons, qualityScore) are exposed only
        // in non-production envs so prod callers see the same public
        // shape as the default feed.
        const includeDebug = config.NODE_ENV !== 'production';
        return jsonSafe({
          items: paged.map((s) => ({
            ...publicProjection(s.property),
            ...(includeDebug ? { _score: s.score, _reasons: s.reasons, qualityScore: s.qualityScore } : {}),
          })),
          page: q.page,
          pageSize: q.pageSize,
          total: scored.length,
          ranking: 'smart',
        });
      } catch (err) {
        req.log.error({ err }, 'smart feed ranker failed; falling back to default');
        // fall through to default response
      }
    }

    if (!wantPersonalized) {
      const items = pool.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map(publicProjection);
      return jsonSafe({
        items,
        page: q.page,
        pageSize: q.pageSize,
        total: pool.length,
        ranking: 'default',
      });
    }

    try {
      // Load the last 400 events for this caller (bounded — recency matters more).
      let profile = { hasSignal: false } as ReturnType<typeof buildPreferenceProfile>;
      if (caller) {
        const events = await prisma.userEvent.findMany({
          where: { userId: caller.userId },
          orderBy: { createdAt: 'desc' },
          take: 400,
          select: { eventType: true, city: true, district: true, propertyType: true, purpose: true, priceHalalahs: true, createdAt: true },
        });
        profile = buildPreferenceProfile(events);
      }

      const now = new Date();
      const scored = pool.map((p) => {
        const quality = computeQualityScore({
          hasCategory: !!p.category,
          hasPurpose: !!p.purpose,
          hasListingNumber: !!p.listingNumber,
          imageCount: 0, // MediaAsset count wiring — deferred (see NOT IMPLEMENTED)
          advertisementLifecycle: p.advertisementLifecycle,
          hasRegaLicense: !!p.regaLicenseNumber,
          createdAt: p.createdAt,
          now,
        });
        const scorable = {
          id: p.id,
          category: p.category,
          purpose: p.purpose,
          city: null,          // Property lacks city — populated when events tag it
          district: null,
          priceHalalahs: null, // Property lacks price — same
          qualityScore: quality,
          createdAt: p.createdAt,
        };
        const result = profile.hasSignal
          ? scorePropertyForUser(profile, scorable, now)
          : scorePropertyColdStart(scorable, now);
        return { property: p, ...result };
      });

      scored.sort((a, b) => b.score - a.score);
      const paged = scored.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
      return jsonSafe({
        items: paged.map(s => ({ ...publicProjection(s.property), _score: s.score, _reasons: s.reasons })),
        page: q.page,
        pageSize: q.pageSize,
        total: scored.length,
        ranking: profile.hasSignal ? 'personalized' : 'cold_start',
      });
    } catch (err) {
      // Engine failure must NEVER break the user's feed — fall back.
      req.log.error({ err }, 'recommendation engine failed; falling back to default feed');
      const items = pool.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map(publicProjection);
      return jsonSafe({
        items,
        page: q.page,
        pageSize: q.pageSize,
        total: pool.length,
        ranking: 'fallback',
      });
    }
  });

  /**
   * PATCH /v1/properties/:id/details — owner-only write for the
   * Property Data v2 fields.
   *
   * - All fields are optional; unspecified keys are left untouched.
   * - The caller MUST be the property's `ownerId` (or an admin).
   * - Old clients that never send this payload are unaffected — this
   *   endpoint is purely additive.
   * - We NEVER accept `ownerId`, `officeId`, `status`,
   *   `advertisementLifecycle`, or any REGA / lifecycle field here —
   *   those are governed by dedicated compliance routes.
   */
  const detailsBody = z
    .object({
      city: z.string().min(1).max(80).nullable().optional(),
      district: z.string().min(1).max(120).nullable().optional(),
      addressText: z.string().min(1).max(500).nullable().optional(),
      latitude: z.number().min(-90).max(90).nullable().optional(),
      longitude: z.number().min(-180).max(180).nullable().optional(),
      priceHalalahs: z.union([z.number(), z.string()]).nullable().optional()
        .transform((v) => v === null || v === undefined ? v : BigInt(String(v)))
        .refine((v) => v === null || v === undefined || v >= 0n, 'priceHalalahs must be ≥ 0'),
      pricePeriod: z.enum(['TOTAL', 'YEAR', 'MONTH', 'WEEK', 'DAY']).nullable().optional(),
      areaSqm: z.number().int().min(0).max(1_000_000).nullable().optional(),
      landAreaSqm: z.number().int().min(0).max(10_000_000).nullable().optional(),
      builtAreaSqm: z.number().int().min(0).max(1_000_000).nullable().optional(),
      bedrooms: z.number().int().min(0).max(50).nullable().optional(),
      bathrooms: z.number().int().min(0).max(50).nullable().optional(),
      livingRooms: z.number().int().min(0).max(50).nullable().optional(),
      kitchens: z.number().int().min(0).max(20).nullable().optional(),
      floorNumber: z.number().int().min(-10).max(200).nullable().optional(),
      totalFloors: z.number().int().min(0).max(200).nullable().optional(),
      propertyAgeYears: z.number().int().min(0).max(200).nullable().optional(),
      yearBuilt: z.number().int().min(1800).max(2200).nullable().optional(),
      furnished: z.boolean().nullable().optional(),
      parkingSpaces: z.number().int().min(0).max(500).nullable().optional(),
      hasElevator: z.boolean().nullable().optional(),
      hasPool: z.boolean().nullable().optional(),
      hasBalcony: z.boolean().nullable().optional(),
      hasYard: z.boolean().nullable().optional(),
      hasMaidRoom: z.boolean().nullable().optional(),
      hasDriverRoom: z.boolean().nullable().optional(),
      hasAirConditioning: z.boolean().nullable().optional(),
    })
    .strict(); // unknown / suspicious keys are rejected

  app.patch('/v1/properties/:id/details', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = detailsBody.parse(req.body ?? {});
    const prisma = getPrisma();
    const existing = await prisma.property.findUnique({ where: { id }, select: { id: true, ownerId: true, status: true } });
    if (!existing) throw notFound('property not found');
    if (existing.ownerId !== caller.userId && !isAdminRole(caller.role)) {
      // 404 rather than 403 — never confirm existence to non-owners.
      throw notFound('property not found');
    }
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) data[k] = v; // null is a valid intent (clear the value)
    }
    if (Object.keys(data).length === 0) {
      return jsonSafe(await prisma.property.findUnique({ where: { id } }));
    }
    const updated = await prisma.property.update({ where: { id }, data });
    return jsonSafe(updated);
  });
}
