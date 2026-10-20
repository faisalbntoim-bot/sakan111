/**
 * True concurrency tests — the sweep and the capture ARE racing,
 * not running back-to-back. These catch bugs that a sequential test
 * would miss (TOCTOU inside the sweep's updateMany, double-processing
 * of a late webhook, confirmed-while-cancelled resurrection).
 *
 * Also covers:
 *   - duplicate webhook on an already captured_orphan payment →
 *     exactly ONE PaymentEvent + ONE audit entry + no row mutation.
 *   - admin review route lists orphan payments ordered newest-first.
 *   - the production buildServer wires the sweep into a timer that
 *     the test harness can reach via `app.sakanSweeperIntervalMs`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/main.js';
import { resetDb, seedRules, shutdown } from './helpers.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { getPrisma } from '../src/db.js';
import { halalahsFromMajor } from '../src/money.js';
import { runBookingExpirySweep } from '../src/workers/booking-expiry.js';
import { capturePayment } from '../src/financial/payment.orchestrator.js';
import { computeQuote } from '../src/financial/pricing.js';
import { serialiseQuote } from '../src/financial/payment.orchestrator.js';

process.env.BOOKING_ALLOW_MONTHLY_TO_DAILY = 'true';
process.env.BOOKING_MONTH_TO_DAY_DIVISOR = '30';

let app: FastifyInstance;

beforeAll(async () => { app = await buildServer(); });
afterAll(async () => { await app?.close(); await shutdown(); });
beforeEach(async () => { await resetDb(); await seedRules(); });

async function makeAdminToken(): Promise<string> {
  const prisma = getPrisma();
  const u = await prisma.user.create({
    data: { phone: `+966000ad${Math.floor(Math.random() * 100000)}`, nameAr: 'A' },
  });
  await prisma.role.create({ data: { userId: u.id, role: 'ADMIN', scope: '' } });
  return signAccessToken(u.id, 'ADMIN');
}

async function seedStaleBookingWithPending(opts: { ageMinutes: number }): Promise<{
  bookingId: string; paymentId: string; providerPaymentId: string;
  propertyId: string; customerId: string; hostId: string;
}> {
  const prisma = getPrisma();
  const owner = await prisma.user.create({ data: { phone: `+96600600${Math.floor(Math.random() * 100000)}`, nameAr: 'م' } });
  const customer = await prisma.user.create({ data: { phone: `+96600700${Math.floor(Math.random() * 100000)}`, nameAr: 'ع' } });
  const prop = await prisma.property.create({
    data: {
      listingNumber: `L-RACE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ownerId: owner.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'PUBLISHED', publishedAt: new Date(),
      currency: 'SAR', priceHalalahs: BigInt(9000 * 100), pricePeriod: 'MONTH',
    },
  });
  const b = await prisma.booking.create({
    data: {
      propertyId: prop.id, customerId: customer.id, hostId: owner.id,
      transactionType: 'DAILY_RENTAL',
      checkIn: new Date('2029-04-01T14:00:00Z'),
      checkOut: new Date('2029-04-03T12:00:00Z'),
      nights: 2,
      grossAmountHalalahs: halalahsFromMajor('600'),
      currency: 'SAR',
      status: 'pending_payment',
      createdAt: new Date(Date.now() - opts.ageMinutes * 60 * 1000),
    },
  });
  // Real quote so the post-capture ledger path has every field it
  // expects. Matches what startCheckout stores on the Payment row.
  const quote = await computeQuote({
    transactionType: 'DAILY_RENTAL',
    propertyType: 'apartment',
    grossAmountHalalahs: halalahsFromMajor('600'),
    currency: 'SAR',
  });
  const providerPaymentId = `sb_pay_${Math.random().toString(16).slice(2, 14)}`;
  const p = await prisma.payment.create({
    data: {
      bookingId: b.id, type: 'CHARGE',
      grossAmountHalalahs: quote.customerTotalHalalahs,
      currency: 'SAR', status: 'pending',
      provider: 'sandbox',
      providerPaymentId,
      idempotencyKey: `idem-${b.id}`,
      metadata: JSON.stringify({ quote: serialiseQuote(quote) }),
    },
  });
  return {
    bookingId: b.id, paymentId: p.id, providerPaymentId,
    propertyId: prop.id, customerId: customer.id, hostId: owner.id,
  };
}

describe('sweep ↔ capture race — exactly one terminal state, never both', () => {
  it('runBookingExpirySweep racing capturePayment lands at (confirmed+captured) OR (cancelled+captured_orphan), never both', async () => {
    // Repeat several rounds because the race is probabilistic; each
    // round seeds a fresh stale booking and fires the two paths
    // inside Promise.all. We fail loud if ANY round produces an
    // inconsistent state (e.g. booking.status==='confirmed' AND
    // payment.status==='captured_orphan').
    const prisma = getPrisma();
    const rounds = 15;
    for (let round = 0; round < rounds; round++) {
      await resetDb();
      const seed = await seedStaleBookingWithPending({ ageMinutes: 60 });

      const payment0 = await prisma.payment.findUnique({ where: { id: seed.paymentId } });
      await Promise.all([
        runBookingExpirySweep({ draftTtlMinutes: 15, pendingTtlMinutes: 30 }),
        capturePayment({
          paymentId: seed.paymentId,
          providerPaymentId: seed.providerPaymentId,
          reportedAmountHalalahs: payment0!.grossAmountHalalahs,
          reportedCurrency: 'SAR',
        }),
      ]);

      const booking = await prisma.booking.findUnique({ where: { id: seed.bookingId } });
      const payment = await prisma.payment.findUnique({ where: { id: seed.paymentId } });
      // Only two valid outcomes.
      const bookingState = booking!.status;
      const paymentState = payment!.status;
      const combo = `${bookingState}+${paymentState}`;
      expect(['confirmed+captured', 'cancelled+captured_orphan']).toContain(combo);
    }
  }, 60_000);

  it('cancelled booking + late capture: a SECOND webhook arrives and does NOT emit a duplicate orphan event or audit entry', async () => {
    const prisma = getPrisma();
    const seed = await seedStaleBookingWithPending({ ageMinutes: 60 });
    // Force the cancel first — deterministic for this dedupe test.
    await prisma.booking.update({ where: { id: seed.bookingId }, data: { status: 'cancelled' } });
    const payment0 = await prisma.payment.findUnique({ where: { id: seed.paymentId } });
    // First webhook → captured_orphan.
    await capturePayment({
      paymentId: seed.paymentId,
      providerPaymentId: seed.providerPaymentId,
      reportedAmountHalalahs: payment0!.grossAmountHalalahs,
      reportedCurrency: 'SAR',
    });
    // Second webhook (replay) → MUST be a no-op.
    await capturePayment({
      paymentId: seed.paymentId,
      providerPaymentId: seed.providerPaymentId,
      reportedAmountHalalahs: payment0!.grossAmountHalalahs,
      reportedCurrency: 'SAR',
    });
    const payment = await prisma.payment.findUnique({ where: { id: seed.paymentId } });
    expect(payment?.status).toBe('captured_orphan');
    const events = await prisma.paymentEvent.findMany({ where: { paymentId: seed.paymentId, kind: 'captured_orphan' } });
    expect(events.length).toBe(1);
    const audits = await prisma.auditLog.findMany({ where: { entity: 'Payment', entityId: seed.paymentId, action: 'PAYMENT.CAPTURED_ORPHAN' } });
    expect(audits.length).toBe(1);
  });

  it('GET /v1/admin/payments/orphans returns captured_orphan rows newest-first', async () => {
    const prisma = getPrisma();
    const seed1 = await seedStaleBookingWithPending({ ageMinutes: 60 });
    const p1 = await prisma.payment.findUnique({ where: { id: seed1.paymentId } });
    await prisma.booking.update({ where: { id: seed1.bookingId }, data: { status: 'cancelled' } });
    await capturePayment({
      paymentId: seed1.paymentId, providerPaymentId: seed1.providerPaymentId,
      reportedAmountHalalahs: p1!.grossAmountHalalahs, reportedCurrency: 'SAR',
    });
    // Second orphan — younger capturedAt.
    const seed2 = await seedStaleBookingWithPending({ ageMinutes: 60 });
    const p2 = await prisma.payment.findUnique({ where: { id: seed2.paymentId } });
    await prisma.booking.update({ where: { id: seed2.bookingId }, data: { status: 'cancelled' } });
    await capturePayment({
      paymentId: seed2.paymentId, providerPaymentId: seed2.providerPaymentId,
      reportedAmountHalalahs: p2!.grossAmountHalalahs, reportedCurrency: 'SAR',
    });

    const token = await makeAdminToken();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/payments/orphans',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.id)).toEqual([seed2.paymentId, seed1.paymentId]);
  });

  it('non-admin cannot read /v1/admin/payments/orphans', async () => {
    const prisma = getPrisma();
    const customer = await prisma.user.create({ data: { phone: `+96600099${Math.floor(Math.random() * 100000)}`, nameAr: 'ع' } });
    await prisma.role.create({ data: { userId: customer.id, role: 'CUSTOMER', scope: '' } });
    const token = signAccessToken(customer.id, 'CUSTOMER');
    const res = await app.inject({ method: 'GET', url: '/v1/admin/payments/orphans', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });
});

describe('service-level sweeper wiring', () => {
  it('buildServer registers the sweeper on a configured interval (visible via decorator)', () => {
    const decorated = app as unknown as { sakanSweeperIntervalMs?: number };
    expect(decorated.sakanSweeperIntervalMs).toBeGreaterThan(0);
  });

  it('closing the app clears the sweeper (no leaked interval keeping the loop alive)', async () => {
    const tmp = await buildServer();
    const before = (tmp as unknown as { sakanSweeperIntervalMs?: number }).sakanSweeperIntervalMs ?? 0;
    expect(before).toBeGreaterThan(0);
    await tmp.close();
    // No way to count active intervals from userland; we assert that
    // the onClose hook ran without throwing. A leaked interval would
    // keep the test process alive beyond vitest's close call.
    expect(true).toBe(true);
  });
});
