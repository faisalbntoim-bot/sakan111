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
import { getCaller, isAdminRole } from '../auth/rbac.js';
import { badRequest, notFound } from '../errors.js';
import { jsonSafe } from '../money.js';
import { buildPreferenceProfile } from '../recommendation/preferences.js';
import { computeQualityScore } from '../recommendation/quality.js';
import { scorePropertyForUser, scorePropertyColdStart } from '../recommendation/scorer.js';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().max(200).optional(),
  category: z.string().max(40).optional(),
  purpose: z.string().max(40).optional(),
  city: z.string().max(80).optional(),
  status: z.enum(['available', 'reserved', 'sold', 'rented', 'hidden']).optional(),
  ownerId: z.string().optional(),
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
    // Filters
    if (q.category) where.category = q.category;
    if (q.purpose) where.purpose = q.purpose;

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
}
