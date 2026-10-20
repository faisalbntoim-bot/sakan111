import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/rbac.js';
import { platformOverview } from '../financial/reporting.js';
import { getPrisma } from '../db.js';
import { jsonSafe } from '../money.js';

const rangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export default async function adminReportRoutes(app: FastifyInstance) {
  const adminOnly = requireRole(['ADMIN', 'FINANCE_ADMIN', 'SUPER_ADMIN']);

  app.get('/v1/admin/overview', async (req, reply) => {
    adminOnly(req, reply);
    const q = rangeSchema.parse(req.query ?? {});
    const overview = await platformOverview({
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    return jsonSafe(overview);
  });

  /**
   * Orphaned captures — payments the PSP captured against a booking
   * that was already cancelled (expired draft/pending). Each row is
   * money we hold that needs operator action: refund the customer or
   * reconcile. We never auto-refund; the operator decides. Listed
   * newest-first so an on-call sees fresh entries first.
   */
  app.get('/v1/admin/payments/orphans', async (req, reply) => {
    adminOnly(req, reply);
    const q = z.object({
      page: z.coerce.number().int().min(1).max(1000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query ?? {});
    const prisma = getPrisma();
    const where = { status: 'captured_orphan' as const };
    const [total, items] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        orderBy: { capturedAt: 'desc' },
        include: {
          booking: {
            select: { id: true, status: true, propertyId: true, customerId: true, checkIn: true, checkOut: true },
          },
          refunds: true,
        },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return jsonSafe({ items, page: q.page, pageSize: q.pageSize, total });
  });
}
