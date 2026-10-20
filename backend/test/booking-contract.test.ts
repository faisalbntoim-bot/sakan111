/**
 * Booking contract tests — the three defences the UI relies on but
 * cannot prove on its own.
 *
 *  1. The sandbox-only dev routes (/v1/dev/sandbox/*) are NOT
 *     registered in production. A prod build returns 404 so the UI
 *     cannot accidentally short-circuit a real PSP by hitting them.
 *
 *  2. GET /v1/bookings/:id for a booking belonging to a DIFFERENT
 *     customer returns 404 (not 403, not 200). We never leak the
 *     existence of other customers' rows.
 *
 *  3. POST /v1/bookings enforces the server-side rate when the
 *     property has unambiguous pricing: a crafted request undercutting
 *     the real total is rejected with 400 (not silently persisted).
 *
 *  4. Two concurrent customers racing the same window — one 200, one
 *     409. SQLite serialises writes but the overlap check lives inside
 *     the transaction, so the race is the real risk this test exists
 *     to pin down.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/main.js';
import { resetDb, shutdown } from './helpers.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { getPrisma } from '../src/db.js';
import { halalahsFromMajor } from '../src/money.js';

// The pricing tests use pricePeriod=MONTH, which requires explicit
// server opt-in. Set BEFORE the config module is first loaded.
process.env.BOOKING_ALLOW_MONTHLY_TO_DAILY = 'true';
process.env.BOOKING_MONTH_TO_DAY_DIVISOR = '30';

let app: FastifyInstance;

beforeAll(async () => { app = await buildServer(); });
afterAll(async () => { await app?.close(); await shutdown(); });
beforeEach(async () => { await resetDb(); });

async function makeCustomerToken(prefix = '2'): Promise<{ userId: string; token: string }> {
  const prisma = getPrisma();
  const user = await prisma.user.create({
    data: { phone: `+966000${prefix}${Math.floor(Math.random() * 100000)}`, nameAr: 'ع' },
  });
  await prisma.role.create({ data: { userId: user.id, role: 'CUSTOMER', scope: '' } });
  return { userId: user.id, token: signAccessToken(user.id, 'CUSTOMER') };
}

async function makeProperty(opts: { priceHalalahs?: bigint; pricePeriod?: string } = {}) {
  const prisma = getPrisma();
  const owner = await prisma.user.create({
    data: { phone: `+96600099${Math.floor(Math.random() * 100000)}`, nameAr: 'م' },
  });
  await prisma.role.create({ data: { userId: owner.id, role: 'OWNER', scope: '' } });
  const prop = await prisma.property.create({
    data: {
      listingNumber: `L-BC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ownerId: owner.id,
      category: 'apartment',
      purpose: 'rent',
      status: 'available',
      advertisementLifecycle: 'PUBLISHED',
      publishedAt: new Date(),
      currency: 'SAR',
      priceHalalahs: opts.priceHalalahs ?? BigInt(9_600_00), // 9600 SAR / month
      pricePeriod: opts.pricePeriod ?? 'MONTH',
    },
  });
  return { propertyId: prop.id, ownerId: owner.id };
}

describe('booking contract — prod isolation, cross-user guard, pricing, concurrency', () => {
  it('cross-user read of GET /v1/bookings/:id returns 404 (customer B cannot see customer A\'s booking)', async () => {
    const { propertyId } = await makeProperty();
    const alice = await makeCustomerToken('1');
    const bob = await makeCustomerToken('2');

    const create = await app.inject({
      method: 'POST', url: '/v1/bookings',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      payload: {
        propertyId,
        transactionType: 'DAILY_RENTAL',
        grossAmount: '960',    // 320/night × 3 nights (9600/30 → 320)
        currency: 'SAR',
        nights: 3,
        checkIn:  '2028-04-01T14:00:00.000Z',
        checkOut: '2028-04-04T12:00:00.000Z',
      },
    });
    expect(create.statusCode).toBe(200);
    const bookingId = create.json().booking.id;

    // Alice can read her own.
    const aliceRead = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}`, headers: { authorization: `Bearer ${alice.token}` } });
    expect(aliceRead.statusCode).toBe(200);

    // Bob cannot — 404, never 200, never 403.
    const bobRead = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}`, headers: { authorization: `Bearer ${bob.token}` } });
    expect(bobRead.statusCode).toBe(404);
    expect(bobRead.json().error).toBe('NOT_FOUND');
  });

  it('server-side pricing: an under-quoted grossAmount is rejected (400 with explicit mismatch message)', async () => {
    const { propertyId } = await makeProperty({ priceHalalahs: BigInt(9_600_00), pricePeriod: 'MONTH' });
    const cust = await makeCustomerToken('1');
    const res = await app.inject({
      method: 'POST', url: '/v1/bookings',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cust.token}` },
      payload: {
        propertyId,
        transactionType: 'DAILY_RENTAL',
        grossAmount: '1',    // 1 SAR for 3 nights × 320 SAR expected — nope.
        currency: 'SAR',
        nights: 3,
        checkIn:  '2028-05-01T14:00:00.000Z',
        checkOut: '2028-05-04T12:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
    expect(res.json().message).toMatch(/grossAmount|does not match/i);
  });

  it('server-side pricing: the matching amount with ±rounding tolerance passes', async () => {
    const { propertyId } = await makeProperty({ priceHalalahs: BigInt(9_600_00), pricePeriod: 'MONTH' });
    const cust = await makeCustomerToken('1');
    // 9600 / 30 = 320 per night; 2 nights = 640; send 640 exactly.
    const res = await app.inject({
      method: 'POST', url: '/v1/bookings',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cust.token}` },
      payload: {
        propertyId,
        transactionType: 'DAILY_RENTAL',
        grossAmount: '640',
        currency: 'SAR',
        nights: 2,
        checkIn:  '2028-06-10T14:00:00.000Z',
        checkOut: '2028-06-12T12:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('server-side pricing: a listing with no pricePeriod is REFUSED for daily rental', async () => {
    const prisma = getPrisma();
    const owner = await prisma.user.create({
      data: { phone: `+96600033${Math.floor(Math.random() * 100000)}`, nameAr: 'م' },
    });
    const prop = await prisma.property.create({
      data: {
        listingNumber: `L-NOPER-${Date.now()}`,
        ownerId: owner.id, category: 'apartment', purpose: 'rent',
        advertisementLifecycle: 'PUBLISHED', publishedAt: new Date(),
        currency: 'SAR', priceHalalahs: BigInt(1000),
        // pricePeriod intentionally omitted.
      },
    });
    const cust = await makeCustomerToken('5');
    const res = await app.inject({
      method: 'POST', url: '/v1/bookings',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cust.token}` },
      payload: {
        propertyId: prop.id,
        transactionType: 'DAILY_RENTAL',
        grossAmount: '100',
        currency: 'SAR',
        nights: 2,
        checkIn:  '2028-10-01T14:00:00.000Z',
        checkOut: '2028-10-03T12:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/pricing not configured/i);
  });

  it('two concurrent customers racing the same window → one 200, one 409', async () => {
    const { propertyId } = await makeProperty({ priceHalalahs: BigInt(9_000_00), pricePeriod: 'MONTH' });
    const alice = await makeCustomerToken('1');
    const bob = await makeCustomerToken('2');

    const body = {
      propertyId,
      transactionType: 'DAILY_RENTAL' as const,
      grossAmount: '600',   // 300/night × 2 nights ← within the pricing tolerance
      currency: 'SAR',
      nights: 2,
      checkIn:  '2028-07-01T14:00:00.000Z',
      checkOut: '2028-07-03T12:00:00.000Z',
    };

    // Fire both requests in the SAME microtask. SQLite will serialise;
    // the overlap check inside the tx guarantees only one wins.
    const [aliceRes, bobRes] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/bookings', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` }, payload: body }),
      app.inject({ method: 'POST', url: '/v1/bookings', headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}`,   authorization2: '' }, payload: body }),
    ]);
    const statuses = [aliceRes.statusCode, bobRes.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    // The winner's booking row exists, the loser's does not.
    const winner = aliceRes.statusCode === 200 ? aliceRes : bobRes;
    const loser  = aliceRes.statusCode === 409 ? aliceRes : bobRes;
    expect(winner.json().booking.status).toBe('draft');
    expect(loser.json().error).toBe('CONFLICT');
    expect(loser.json().message).toMatch(/not available/i);

    // DB side: exactly one booking row for this property.
    const rows = await getPrisma().booking.findMany({ where: { propertyId } });
    expect(rows.length).toBe(1);
  });
});

describe('draft hold + late capture', () => {
  it('a draft older than draftTtlMinutes gets cancelled and its dates free up', async () => {
    const { propertyId } = await makeProperty({ priceHalalahs: BigInt(9_000_00), pricePeriod: 'MONTH' });
    const alice = await makeCustomerToken('1');
    const bob = await makeCustomerToken('2');

    // Alice: create a draft (POST /v1/bookings). The route backdates
    // the created_at so the expiry worker sees it as stale.
    const draftRes = await app.inject({
      method: 'POST', url: '/v1/bookings',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      payload: {
        propertyId,
        transactionType: 'DAILY_RENTAL',
        grossAmount: '600',  // 300/night × 2 nights (9000/30 → 300)
        currency: 'SAR',
        nights: 2,
        checkIn:  '2028-08-01T14:00:00.000Z',
        checkOut: '2028-08-03T12:00:00.000Z',
      },
    });
    expect(draftRes.statusCode).toBe(200);
    const draftId = draftRes.json().booking.id;

    // Alice walks away. Nudge the row's createdAt backward so the
    // sweep sees it as stale.
    await getPrisma().booking.update({
      where: { id: draftId },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    // Sweep.
    const { runBookingExpirySweep } = await import('../src/workers/booking-expiry.js');
    const sweep = await runBookingExpirySweep({ draftTtlMinutes: 15, pendingTtlMinutes: 30 });
    expect(sweep.cancelled).toContain(draftId);

    // Bob tries the same window — now allowed.
    const bobRes = await app.inject({
      method: 'POST', url: '/v1/bookings',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      payload: {
        propertyId,
        transactionType: 'DAILY_RENTAL',
        grossAmount: '600',
        currency: 'SAR',
        nights: 2,
        checkIn:  '2028-08-01T14:00:00.000Z',
        checkOut: '2028-08-03T12:00:00.000Z',
      },
    });
    expect(bobRes.statusCode).toBe(200);
  });

  it('a late payment capture against a CANCELLED booking does NOT re-confirm the booking', async () => {
    // Build a payment attached to a booking we then cancel. Capture
    // should mark the payment captured_orphan and leave the booking
    // alone. A new customer could re-book the same window.
    const prisma = getPrisma();
    const { propertyId, ownerId } = await makeProperty({ priceHalalahs: BigInt(9_000_00), pricePeriod: 'MONTH' });
    const customer = await prisma.user.create({ data: { phone: `+966000${Math.random().toString().slice(2, 7)}`, nameAr: 'ع' } });

    const booking = await prisma.booking.create({
      data: {
        propertyId,
        customerId: customer.id,
        hostId: ownerId,
        transactionType: 'DAILY_RENTAL',
        grossAmountHalalahs: halalahsFromMajor('600'),
        currency: 'SAR',
        status: 'pending_payment',
        checkIn:  new Date('2028-09-01T14:00:00Z'),
        checkOut: new Date('2028-09-03T12:00:00Z'),
      },
    });
    const payment = await prisma.payment.create({
      data: {
        bookingId: booking.id, type: 'CHARGE',
        grossAmountHalalahs: halalahsFromMajor('634.5'),
        currency: 'SAR', status: 'pending',
        provider: 'sandbox',
        providerPaymentId: 'sb_pay_latewebhookxx',
        idempotencyKey: `idem-late-${booking.id}`,
        metadata: JSON.stringify({ quote: { customerTotalHalalahs: '63450' } }),
      },
    });

    // Expire + cancel the booking BEFORE the webhook arrives.
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'cancelled' } });

    const { capturePayment } = await import('../src/financial/payment.orchestrator.js');
    await capturePayment({
      paymentId: payment.id,
      providerPaymentId: 'sb_pay_latewebhookxx',
      reportedAmountHalalahs: halalahsFromMajor('634.5'),
      reportedCurrency: 'SAR',
    });

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    const pafter = await prisma.payment.findUnique({ where: { id: payment.id } });
    // Booking stayed cancelled: NO silent resurrection.
    expect(after?.status).toBe('cancelled');
    // Payment marked as orphan — ledger / settlement / invoice NOT fired.
    expect(pafter?.status).toBe('captured_orphan');
  });
});

describe('dev sandbox routes are production-isolated', () => {
  it('on the dev-built app, the dev route exists (control case — 401 without a token)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dev/sandbox/capture/sb_pay_000000000000',
    });
    // Route exists → auth middleware rejects first. If this ever
    // became 404 on the dev build, the test harness is lying to us.
    expect(res.statusCode).toBe(401);
  });

  it('a Fastify instance registered with devSandboxRoutes stubbed as prod returns 404 for /v1/dev/sandbox/*', async () => {
    // Replicate the production guard in isolation. We import the real
    // route module and call it against a prod-like config stub so the
    // early-return branch runs — then an inject must 404.
    const Fastify = (await import('fastify')).default;
    const { default: devSandboxRoutes } = await import('../src/routes/dev.sandbox.js');
    const prodLike = Fastify({ logger: false });
    // Monkey-patch the config module inside this import so NODE_ENV
    // reads as 'production'. We cannot vi.doMock after the fact for an
    // already-imported module, but devSandboxRoutes closes over
    // `config` imported at module load — so we recreate the guard
    // locally by registering a WRAPPER that mirrors the production
    // early-return.
    await prodLike.register(async (scope) => {
      // The real route only self-registers when NODE_ENV ∈
      // {development, test}. We call the route function directly with
      // a fake NODE_ENV=production and prove it is a no-op by
      // checking that /v1/dev/sandbox/* resolves 404.
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try { await devSandboxRoutes(scope); }
      finally { process.env.NODE_ENV = origEnv ?? 'test'; }
    });
    await prodLike.ready();
    try {
      const res = await prodLike.inject({
        method: 'POST',
        url: '/v1/dev/sandbox/capture/sb_pay_000000000000',
      });
      // 404 confirms the route never registered. If the guard regressed
      // (e.g. someone removed the `return`) the request would reach
      // requireAuth and surface 401 instead.
      expect(res.statusCode).toBe(404);
    } finally {
      await prodLike.close();
    }
  });
});
