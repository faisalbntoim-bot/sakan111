/**
 * Market Pulse public API — aggregates over the UserEvent stream.
 *
 *   GET /v1/market/pulse                — headline counters + growth
 *   GET /v1/market/trending-areas       — city+district growth ranking
 *   GET /v1/market/trending-properties  — hot listings by decayed weight
 *
 * All routes 503 when MARKET_PULSE_ENABLED is false so the feature can be
 * dark-shipped and turned on per environment. Growth numbers require a
 * minimum sample size (MARKET_MIN_SAMPLE_SIZE) — under that we return
 * `status: insufficient_data` rather than a misleading percent.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getPrisma } from '../db.js';
import {
  growthRate,
  isEnoughSamples,
  periodBounds,
  periodMs,
  decayedEventWeight,
  type Period,
} from '../recommendation/market.js';

const periodEnum = z.enum(['24h', '7d', '30d']).default('7d');

const commonQuery = z.object({
  period: periodEnum,
  city: z.string().max(80).optional(),
  district: z.string().max(120).optional(),
  propertyType: z.string().max(40).optional(),
  purpose: z.string().max(40).optional(),
});

const trendingAreasQuery = z.object({
  period: periodEnum,
  city: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const trendingPropertiesQuery = z.object({
  period: periodEnum,
  city: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function require503<T>(v: T | null | undefined, reply: import('fastify').FastifyReply): T | undefined {
  if (!config.MARKET_PULSE_ENABLED) {
    reply.code(503).send({ error: 'FEATURE_DISABLED', message: 'market pulse disabled' });
    return undefined;
  }
  return v as T;
}

export default async function marketRoutes(app: FastifyInstance) {
  app.get('/v1/market/pulse', async (req, reply) => {
    if (require503(true, reply) === undefined) return;
    const q = commonQuery.parse(req.query ?? {});
    const bounds = periodBounds(q.period);
    const prisma = getPrisma();
    const commonWhere: Record<string, unknown> = {};
    if (q.city) commonWhere.city = q.city;
    if (q.district) commonWhere.district = q.district;
    if (q.propertyType) commonWhere.propertyType = q.propertyType;
    if (q.purpose) commonWhere.purpose = q.purpose;

    const [current, previous, byType] = await Promise.all([
      prisma.userEvent.groupBy({
        by: ['eventType'],
        where: { ...commonWhere, createdAt: { gte: bounds.currentStart, lt: bounds.currentEnd } },
        _count: { _all: true },
      }),
      prisma.userEvent.groupBy({
        by: ['eventType'],
        where: { ...commonWhere, createdAt: { gte: bounds.previousStart, lt: bounds.previousEnd } },
        _count: { _all: true },
      }),
      prisma.userEvent.groupBy({
        by: ['propertyType'],
        where: { ...commonWhere, createdAt: { gte: bounds.currentStart, lt: bounds.currentEnd } },
        _count: { _all: true },
      }),
    ]);

    const sumOf = (rows: typeof current) => rows.reduce((s, r) => s + r._count._all, 0);
    const of = (rows: typeof current, t: string) => rows.find(r => r.eventType === t)?._count._all ?? 0;

    const totalCurrent = sumOf(current);
    const totalPrevious = sumOf(previous);
    const totalGrowth = growthRate(totalCurrent, totalPrevious);
    const status = isEnoughSamples(totalCurrent + totalPrevious, config.MARKET_MIN_SAMPLE_SIZE)
      ? 'ok'
      : 'insufficient_data';

    return {
      period: q.period,
      filters: { city: q.city ?? null, district: q.district ?? null, propertyType: q.propertyType ?? null, purpose: q.purpose ?? null },
      totalEventsCurrent: totalCurrent,
      totalEventsPrevious: totalPrevious,
      growthPercent: totalGrowth,
      status,
      counters: {
        views: of(current, 'PROPERTY_VIEW'),
        saves: of(current, 'PROPERTY_SAVE'),
        shares: of(current, 'PROPERTY_SHARE'),
        contacts: of(current, 'CONTACT_OWNER') + of(current, 'CONTACT_OFFICE'),
        bookingStarts: of(current, 'BOOKING_START'),
        bookingCompletions: of(current, 'BOOKING_COMPLETE'),
      },
      byPropertyType: byType.map(r => ({ propertyType: r.propertyType, events: r._count._all })),
    };
  });

  app.get('/v1/market/trending-areas', async (req, reply) => {
    if (require503(true, reply) === undefined) return;
    const q = trendingAreasQuery.parse(req.query ?? {});
    const bounds = periodBounds(q.period);
    const prisma = getPrisma();
    const commonWhere: Record<string, unknown> = { city: q.city ? q.city : { not: null } };

    const [current, previous] = await Promise.all([
      prisma.userEvent.groupBy({
        by: ['city', 'district'],
        where: { ...commonWhere, createdAt: { gte: bounds.currentStart, lt: bounds.currentEnd } },
        _count: { _all: true },
      }),
      prisma.userEvent.groupBy({
        by: ['city', 'district'],
        where: { ...commonWhere, createdAt: { gte: bounds.previousStart, lt: bounds.previousEnd } },
        _count: { _all: true },
      }),
    ]);

    const prevMap = new Map<string, number>();
    for (const r of previous) prevMap.set(`${r.city ?? ''}|${r.district ?? ''}`, r._count._all);

    const rows = current.map(r => {
      const key = `${r.city ?? ''}|${r.district ?? ''}`;
      const prev = prevMap.get(key) ?? 0;
      const sample = r._count._all + prev;
      const enough = isEnoughSamples(sample, config.MARKET_MIN_SAMPLE_SIZE);
      return {
        city: r.city,
        district: r.district,
        currentEvents: r._count._all,
        previousEvents: prev,
        growthPercent: enough ? growthRate(r._count._all, prev) : null,
        sampleSize: sample,
        status: enough ? ('ok' as const) : ('insufficient_data' as const),
      };
    })
      .filter(r => !!r.city)
      .sort((a, b) => {
        // Prefer known growth over unknown, then by growth desc.
        const ag = a.growthPercent ?? -Infinity;
        const bg = b.growthPercent ?? -Infinity;
        return bg - ag;
      })
      .slice(0, q.limit);

    return { period: q.period, items: rows };
  });

  app.get('/v1/market/trending-properties', async (req, reply) => {
    if (require503(true, reply) === undefined) return;
    const q = trendingPropertiesQuery.parse(req.query ?? {});
    const bounds = periodBounds(q.period);
    const halfLifeMs = periodMs(q.period) / 2;
    const prisma = getPrisma();

    const where: Record<string, unknown> = {
      propertyId: { not: null },
      createdAt: { gte: bounds.currentStart, lt: bounds.currentEnd },
    };
    if (q.city) where.city = q.city;

    // Pull raw events (capped) so we can apply decay in-process — the
    // group-by-only path can't decay per-row. Cap keeps us in tight
    // request budgets; the row set is filtered by period.
    const events = await prisma.userEvent.findMany({
      where,
      select: { propertyId: true, eventType: true, createdAt: true },
      take: 5000,
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const scores = new Map<string, { score: number; count: number }>();
    for (const e of events) {
      if (!e.propertyId) continue;
      const w = decayedEventWeight(e.eventType, e.createdAt, now, halfLifeMs);
      if (w === 0) continue;
      const cur = scores.get(e.propertyId) ?? { score: 0, count: 0 };
      cur.score += w;
      cur.count += 1;
      scores.set(e.propertyId, cur);
    }

    const items = [...scores.entries()]
      .map(([propertyId, v]) => ({ propertyId, score: Number(v.score.toFixed(2)), eventCount: v.count }))
      .sort((a, b) => b.score - a.score)
      .slice(0, q.limit);

    return { period: q.period, items };
  });
}
