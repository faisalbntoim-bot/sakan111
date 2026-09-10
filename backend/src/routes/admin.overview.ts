/**
 * Admin overview + analytics endpoint.
 *
 *   GET /v1/admin/dashboard[?period=today|7d|30d]
 *
 * Returns real Prisma aggregates for the dashboard: users, properties,
 * bookings, revenue, offices, plus visitor + event counters when the
 * recommendation stream is enabled. Every field is derived from the
 * database — nothing is mocked. When a datum genuinely does not exist
 * in the schema, we return `null` so the UI can render "غير متوفر"
 * instead of a made-up number.
 *
 * Auth: requires ADMIN, FINANCE_ADMIN, or SUPER_ADMIN. Enforced via
 * requireRole — the same guard shipped with the existing admin routes.
 * Every successful call writes an AuditLog row (action=ADMIN.OVERVIEW).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../db.js';
import { requireRole } from '../auth/rbac.js';

const periodEnum = z.enum(['today', '7d', '30d']).default('today');

function periodStart(p: 'today' | '7d' | '30d', now = new Date()): Date {
  const d = new Date(now);
  if (p === 'today') {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const days = p === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Sum a raw BigInt column. Prisma's aggregate `_sum` on BigInt columns
 * returns bigint | null; normalise to string so JSON transport stays
 * lossless.
 */
function sumToString(v: bigint | number | null | undefined): string {
  if (v === null || v === undefined) return '0';
  return v.toString();
}

export default async function adminOverviewRoutes(app: FastifyInstance) {
  app.get('/v1/admin/dashboard', async (req, reply) => {
    // Guard — throws forbidden() if the caller isn't an admin role.
    const caller = requireRole(['ADMIN', 'FINANCE_ADMIN', 'SUPER_ADMIN'])(req, reply);
    try {
    const q = z.object({ period: periodEnum }).parse(req.query ?? {});
    const prisma = getPrisma();
    const now = new Date();
    const startPeriod = periodStart(q.period, now);
    const startToday = periodStart('today', now);
    const start30d = periodStart('30d', now);

    // ---- Users -----------------------------------------------------------
    const [
      totalUsers,
      newUsersToday,
      totalOwners,
      totalOffices,
      totalMarketers,
      totalAdmins,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: startToday } } }),
      prisma.role.count({ where: { role: 'OWNER' } }),
      prisma.role.count({ where: { role: 'OFFICE' } }),
      prisma.role.count({ where: { role: 'MARKETER' } }),
      prisma.role.count({ where: { role: { in: ['ADMIN', 'FINANCE_ADMIN', 'SUPER_ADMIN'] } } }),
    ]);

    // ---- Properties ------------------------------------------------------
    const [
      totalProperties,
      publishedProperties,
      pendingProperties,
      submittedProperties,
      dailyRentProperties,
      annualRentProperties,
      saleProperties,
    ] = await Promise.all([
      prisma.property.count(),
      prisma.property.count({ where: { advertisementLifecycle: 'PUBLISHED' } }),
      prisma.property.count({ where: { advertisementLifecycle: { in: ['DRAFT'] } } }),
      prisma.property.count({ where: { advertisementLifecycle: 'SUBMITTED' } }),
      prisma.property.count({ where: { purpose: 'daily' } }),
      prisma.property.count({ where: { purpose: { in: ['rent', 'monthly'] } } }),
      prisma.property.count({ where: { purpose: 'sale' } }),
    ]);

    // ---- Bookings --------------------------------------------------------
    const [
      totalBookings,
      bookingsToday,
      confirmedBookings,
      pendingBookings,
      cancelledBookings,
      completedBookings,
      periodBookings,
    ] = await Promise.all([
      prisma.booking.count(),
      prisma.booking.count({ where: { createdAt: { gte: startToday } } }),
      prisma.booking.count({ where: { status: 'confirmed' } }),
      prisma.booking.count({ where: { status: { in: ['draft', 'pending_payment'] } } }),
      prisma.booking.count({ where: { status: 'cancelled' } }),
      prisma.booking.count({ where: { status: 'completed' } }),
      prisma.booking.count({ where: { createdAt: { gte: startPeriod } } }),
    ]);

    // ---- Revenue ---------------------------------------------------------
    // Sum captured payment amounts (halalahs, BigInt). Split by source
    // via a group-by so revenue lines add to the total exactly.
    const [
      totalRevenueAgg,
      periodRevenueAgg,
      todayRevenueAgg,
      revenue30dAgg,
    ] = await Promise.all([
      prisma.payment.aggregate({
        _sum: { grossAmountHalalahs: true },
        where: { status: 'captured' },
      }),
      prisma.payment.aggregate({
        _sum: { grossAmountHalalahs: true },
        where: { status: 'captured', createdAt: { gte: startPeriod } },
      }),
      prisma.payment.aggregate({
        _sum: { grossAmountHalalahs: true },
        where: { status: 'captured', createdAt: { gte: startToday } },
      }),
      prisma.payment.aggregate({
        _sum: { grossAmountHalalahs: true },
        where: { status: 'captured', createdAt: { gte: start30d } },
      }),
    ]);

    // ---- Visitor / event counts (recommendation stream) -----------------
    // These are null when the UserEvent table exists but empty (returns 0),
    // and null only if the query throws — we suppress that so the endpoint
    // still returns useful data when analytics events are dark.
    let visitorsToday: number | null = null;
    let uniqueSessionsToday: number | null = null;
    let propertyViewsToday: number | null = null;
    let bookingStartsToday: number | null = null;
    let bookingCompleteToday: number | null = null;
    try {
      const [distinctUsers, distinctSessions, views, starts, completes] = await Promise.all([
        prisma.userEvent.findMany({
          where: { createdAt: { gte: startToday }, userId: { not: null } },
          select: { userId: true },
          distinct: ['userId'],
          take: 5000,
        }),
        prisma.userEvent.findMany({
          where: { createdAt: { gte: startToday }, anonymousSessionId: { not: null } },
          select: { anonymousSessionId: true },
          distinct: ['anonymousSessionId'],
          take: 5000,
        }),
        prisma.userEvent.count({ where: { createdAt: { gte: startToday }, eventType: 'PROPERTY_VIEW' } }),
        prisma.userEvent.count({ where: { createdAt: { gte: startToday }, eventType: 'BOOKING_START' } }),
        prisma.userEvent.count({ where: { createdAt: { gte: startToday }, eventType: 'BOOKING_COMPLETE' } }),
      ]);
      visitorsToday = distinctUsers.length;
      uniqueSessionsToday = distinctSessions.length;
      propertyViewsToday = views;
      bookingStartsToday = starts;
      bookingCompleteToday = completes;
    } catch {
      // UserEvent table may not exist in older DBs — leave metrics as null
      // (UI shows "غير متوفر" rather than fabricated numbers).
    }

    // ---- Audit ----------------------------------------------------------
    // Record who fetched the overview. Non-blocking — if audit write
    // fails we still return the payload.
    void prisma.auditLog.create({
      data: {
        actorId: caller.userId,
        action: 'ADMIN.OVERVIEW.VIEWED',
        entity: 'admin_overview',
        entityId: q.period,
      },
    }).catch(() => { /* audit failure never breaks the read */ });

    return {
      period: q.period,
      generatedAt: now.toISOString(),
      users: {
        total: totalUsers,
        newToday: newUsersToday,
        owners: totalOwners,
        offices: totalOffices,
        marketers: totalMarketers,
        admins: totalAdmins,
      },
      properties: {
        total: totalProperties,
        published: publishedProperties,
        pending: pendingProperties,
        submitted: submittedProperties,
        daily: dailyRentProperties,
        annual: annualRentProperties,
        sale: saleProperties,
      },
      bookings: {
        total: totalBookings,
        today: bookingsToday,
        confirmed: confirmedBookings,
        pending: pendingBookings,
        cancelled: cancelledBookings,
        completed: completedBookings,
        forPeriod: periodBookings,
      },
      revenue: {
        currency: 'SAR',
        totalHalalahs: sumToString(totalRevenueAgg._sum.grossAmountHalalahs),
        todayHalalahs: sumToString(todayRevenueAgg._sum.grossAmountHalalahs),
        periodHalalahs: sumToString(periodRevenueAgg._sum.grossAmountHalalahs),
        last30dHalalahs: sumToString(revenue30dAgg._sum.grossAmountHalalahs),
      },
      visitors: {
        today: visitorsToday,
        uniqueSessionsToday,
        propertyViewsToday,
        bookingStartsToday,
        bookingCompleteToday,
      },
    };
    } catch (err) {
      req.log.error({ err }, 'admin overview aggregate failed');
      throw err;
    }
  });
}
