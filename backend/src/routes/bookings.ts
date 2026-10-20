import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db.js';
import { requireAuth, isAdminRole } from '../auth/rbac.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { computeQuote } from '../financial/pricing.js';
import { halalahsFromMajor, jsonSafe } from '../money.js';
import { config } from '../config.js';

/**
 * Server-side price verification policy for DAILY_RENTAL bookings.
 *
 *  - pricePeriod === 'DAY'   → nights × price (always)
 *  - pricePeriod === 'MONTH' → ONLY when `BOOKING_ALLOW_MONTHLY_TO_DAILY=true`.
 *                              Rate = floor(price / BOOKING_MONTH_TO_DAY_DIVISOR).
 *                              Floor (not round) so the derived rate never
 *                              over-charges the customer.
 *  - any other period        → reject (explicit opt-in needed).
 *
 * Returns the expected gross in halalahs, or null if the policy cannot
 * price this listing for a daily rental and the booking should be
 * refused with a 400.
 */
function expectedDailyRentalHalalahs(
  property: { priceHalalahs: bigint | number | null; pricePeriod: string | null },
  nights: number,
): bigint | null {
  if (property.priceHalalahs == null || !property.pricePeriod || nights <= 0) return null;
  const price = BigInt(property.priceHalalahs);
  const period = String(property.pricePeriod).toUpperCase();
  if (period === 'DAY') return price * BigInt(nights);
  if (period === 'MONTH') {
    if (!config.BOOKING_ALLOW_MONTHLY_TO_DAILY) return null;
    const divisor = BigInt(config.BOOKING_MONTH_TO_DAY_DIVISOR);
    if (divisor <= 0n) return null;
    const perNight = price / divisor;              // floor division on BigInt
    return perNight > 0n ? perNight * BigInt(nights) : null;
  }
  return null;
}

const createSchema = z.object({
  propertyId: z.string().min(1),
  transactionType: z.enum(['DAILY_RENTAL', 'LONG_TERM_RENTAL', 'COMMERCIAL_RENTAL', 'SALE']),
  grossAmount: z.union([z.string(), z.number()]),   // in major units (e.g. "300" for 300 SAR)
  currency: z.string().length(3).default('SAR'),
  nights: z.number().int().positive().optional(),
  checkIn: z.string().datetime().optional(),
  checkOut: z.string().datetime().optional(),
  idempotencyKey: z.string().min(4).optional(),
});

export default async function bookingRoutes(app: FastifyInstance) {
  app.post('/v1/bookings', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const body = createSchema.parse(req.body);
    const prisma = getPrisma();
    const property = await prisma.property.findUnique({ where: { id: body.propertyId } });
    if (!property) throw notFound('property not found');

    const gross = halalahsFromMajor(body.grossAmount);
    if (gross <= 0n) throw badRequest('grossAmount must be positive');

    // Currency must match the property.
    if (body.currency !== property.currency) {
      throw badRequest(`booking currency ${body.currency} does not match property currency ${property.currency}`);
    }

    // Server-side price verification for daily rentals: when the
    // property has an unambiguous per-day or per-month rate and the
    // caller provides a nights count, we recompute the expected gross
    // and reject any client-sent value that drifts more than 1 halalah
    // (rounding). Without this, a malicious client could POST a
    // grossAmount of "1" against a 900 SAR booking and pay almost
    // nothing. We leave the check off for ambiguous shapes (SALE,
    // COMMERCIAL_RENTAL, LONG_TERM_RENTAL custom quotes) so this never
    // becomes a false-positive on a legitimate price change.
    // Server-side pricing for DAILY_RENTAL. We NEVER trust the client
    // for compatibility — the gross stored on the booking row is
    // computed from the property + nights; the client's amount is
    // only tolerated when it rounds within ±1 halalah per night. A
    // listing that cannot be priced (no priceHalalahs, no supported
    // period, or opt-in disabled for MONTH→DAY) refuses the booking
    // outright; no fallback to the client-sent number.
    let serverGross: bigint = gross;
    if (body.transactionType === 'DAILY_RENTAL') {
      if (!body.nights) {
        throw badRequest('nights is required for DAILY_RENTAL bookings');
      }
      if (property.priceHalalahs == null) {
        throw badRequest(
          'listing has no price configured; it cannot accept a daily rental until the owner publishes a priceHalalahs',
        );
      }
      const expected = expectedDailyRentalHalalahs(property, body.nights);
      if (expected === null) {
        throw badRequest(
          'daily-rental pricing not configured for this listing (set pricePeriod=DAY,' +
          ' or enable BOOKING_ALLOW_MONTHLY_TO_DAILY to derive a per-day rate from the monthly price)',
        );
      }
      // Rounding tolerance: 1 halalah per night. floor(price/divisor)
      // can drop at most 1 halalah on each day's share, so three
      // nights can diverge by up to 3 halalahs vs. a client that
      // rounded differently. Larger drifts are a mismatch, not noise.
      const tolerance = BigInt(body.nights);
      const delta = gross > expected ? gross - expected : expected - gross;
      if (delta > tolerance) {
        throw badRequest(
          `grossAmount does not match the server-side rate` +
          ` (expected ${expected.toString()} halalahs ±${tolerance.toString()}, got ${gross.toString()})`,
        );
      }
      // Persist the SERVER'S number, not the client's — a client whose
      // display rounded differently must not change what we charge.
      serverGross = expected;
    }

    // Determine host from PropertyHost for DAILY_RENTAL, else owner.
    let hostId = property.ownerId;
    if (body.transactionType === 'DAILY_RENTAL') {
      const primary = await prisma.propertyHost.findFirst({ where: { propertyId: property.id, isPrimary: true } });
      hostId = primary?.hostId ?? property.ownerId;
    }

    // Availability guard for date-based transactions.
    //
    // Serialisation strategy — DB-level, so it survives across backend
    // processes behind a load balancer (an in-process mutex would not).
    // The first write inside the Prisma transaction is an UPDATE on
    // the property row (`updatedAt=NOW()`). SQLite promotes a tx to
    // the RESERVED lock on write and serialises concurrent writers at
    // the engine level; Postgres takes a ROW EXCLUSIVE lock on the
    // row for the duration of the tx, so a second transaction trying
    // to take the same lock blocks until the first commits.
    // Either way, the overlap SELECT that follows is guaranteed to
    // see any committed sibling bookings.
    const booking = await prisma.$transaction(async (tx) => {
      // Acquire the write lock first — before any SELECT — so sibling
      // transactions queue at this UPDATE rather than racing past the
      // overlap check.
      await tx.property.update({
        where: { id: property.id },
        data: { updatedAt: new Date() },
      });
      if (body.checkIn && body.checkOut) {
        const checkIn  = new Date(body.checkIn);
        const checkOut = new Date(body.checkOut);
        if (checkIn.getTime() >= checkOut.getTime()) throw badRequest('checkIn must be before checkOut');
        // 'draft' is included: a freshly-created booking is a tentative
        // hold on the dates until the customer either pays (→
        // 'pending_payment' / 'confirmed') or the booking-expiry
        // worker sweeps it (BOOKING_DRAFT_TTL_MINUTES). Without this,
        // two concurrent customers could both land their first POST
        // and only find out one of them is doomed at startCheckout.
        const overlap = await tx.booking.findFirst({
          where: {
            propertyId: property.id,
            status: { in: ['draft', 'pending_payment', 'confirmed'] },
            AND: [
              { checkIn:  { lt: checkOut } },
              { checkOut: { gt: checkIn } },
            ],
          },
          select: { id: true },
        });
        if (overlap) throw conflict('property is not available for the selected dates');
      }
      return tx.booking.create({
        data: {
          propertyId: property.id,
          customerId: caller.userId,
          hostId,
          transactionType: body.transactionType,
          checkIn: body.checkIn ? new Date(body.checkIn) : null,
          checkOut: body.checkOut ? new Date(body.checkOut) : null,
          nights: body.nights ?? null,
          grossAmountHalalahs: serverGross,
          currency: body.currency,
          idempotencyKey: body.idempotencyKey ?? null,
        },
      });
    });

    // Attach a quote preview to the response.
    const quote = await computeQuote({
      transactionType: body.transactionType,
      propertyType: property.category,
      grossAmountHalalahs: serverGross,
      currency: body.currency,
    });
    return jsonSafe({ booking, quote });
  });

  app.get('/v1/bookings', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const q = z.object({
      page: z.coerce.number().int().min(1).max(1000).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(20),
      status: z.enum(['draft', 'pending_payment', 'confirmed', 'cancelled', 'completed']).optional(),
      sort: z.enum(['createdAt.asc', 'createdAt.desc', 'checkIn.asc', 'checkIn.desc']).default('createdAt.desc'),
    }).parse(req.query ?? {});

    // Auth scope: the caller's userId — NEVER read a guestId query parameter.
    // Admins may pass ?customerId=... explicitly to look up another user (admin-only).
    const adminCustomerId = req.query && typeof (req.query as Record<string, unknown>).customerId === 'string'
      ? (req.query as Record<string, string>).customerId
      : undefined;
    let customerId = caller.userId;
    if (adminCustomerId) {
      if (caller.role !== 'ADMIN' && caller.role !== 'FINANCE_ADMIN' && caller.role !== 'SUPER_ADMIN') {
        // Non-admins requesting someone else's list get an empty list, not a 403 (avoids probing).
        return { items: [], page: q.page, pageSize: q.pageSize, total: 0 };
      }
      customerId = adminCustomerId;
    }

    const prisma = getPrisma();
    const where = { customerId, ...(q.status ? { status: q.status } : {}) };
    const [sortField, sortDir] = q.sort.split('.') as ['createdAt' | 'checkIn', 'asc' | 'desc'];
    const [total, rows] = await Promise.all([
      prisma.booking.count({ where }),
      prisma.booking.findMany({
        where,
        orderBy: { [sortField]: sortDir },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return jsonSafe({ items: rows, page: q.page, pageSize: q.pageSize, total });
  });

  app.get('/v1/bookings/:id', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const booking = await getPrisma().booking.findUnique({
      where: { id },
      include: { items: true, payments: true, invoice: true, property: true },
    });
    if (!booking) throw notFound('booking not found');
    if (booking.customerId !== caller.userId && !isAdminRole(caller.role) && caller.userId !== booking.hostId) {
      // Owners/hosts/admin can read; others 404 to avoid probing.
      throw notFound('booking not found');
    }
    return jsonSafe(booking);
  });

  app.post('/v1/quote', async (req) => {
    const body = z.object({
      transactionType: z.enum(['DAILY_RENTAL', 'LONG_TERM_RENTAL', 'COMMERCIAL_RENTAL', 'SALE', 'ADVERTISEMENT', 'SUBSCRIPTION', 'SERVICE']),
      propertyType: z.string().optional(),
      grossAmount: z.union([z.string(), z.number()]),
      currency: z.string().length(3).default('SAR'),
    }).parse(req.body);
    const q = await computeQuote({
      transactionType: body.transactionType,
      propertyType: body.propertyType,
      grossAmountHalalahs: halalahsFromMajor(body.grossAmount),
      currency: body.currency,
    });
    return jsonSafe(q);
  });
}
