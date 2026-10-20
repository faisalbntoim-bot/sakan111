/**
 * Regression test for the setErrorHandler placement.
 *
 * Previously `app.setErrorHandler` was called AFTER `app.register(xRoutes)`
 * in main.ts. In Fastify's encapsulation model that lets the DEFAULT error
 * serializer leak through — a `conflict()` thrown inside a route surfaced
 * as HTTP 500 with Fastify's canned
 *   {"statusCode":500,"code":"CONFLICT","error":"Internal Server Error",...}
 * instead of our custom
 *   {"error":"CONFLICT","message":"…","requestId":"…"} with HTTP 409.
 *
 * This test boots the REAL `buildServer()` and injects three requests:
 *   1. unauth POST /v1/bookings → 401 UNAUTHORIZED
 *   2. overlapping POST /v1/bookings → 409 CONFLICT
 *   3. invalid-body POST /v1/bookings → 400 VALIDATION
 *
 * If the setErrorHandler ever moves back after the route registrations
 * (or the duck-type check regresses) all three assertions fail.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/main.js';
import { resetDb, shutdown } from './helpers.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { getPrisma } from '../src/db.js';
import { halalahsFromMajor } from '../src/money.js';

let app: FastifyInstance;

beforeAll(async () => {
  // The server reads JWT_SECRET at config load; the test harness
  // (test/vitest.setup.ts) already sets it. We just need to boot.
  app = await buildServer();
});

afterAll(async () => {
  await app?.close();
  await shutdown();
});

beforeEach(async () => { await resetDb(); });

async function makeCustomerToken(): Promise<{ userId: string; token: string }> {
  const prisma = getPrisma();
  const user = await prisma.user.create({
    data: { phone: `+9660000${Math.floor(Math.random() * 100000)}`, nameAr: 'ع' },
  });
  await prisma.role.create({ data: { userId: user.id, role: 'CUSTOMER', scope: '' } });
  const token = signAccessToken(user.id, 'CUSTOMER');
  return { userId: user.id, token };
}

async function seedOwnerAndProperty(): Promise<{ ownerId: string; propertyId: string }> {
  const prisma = getPrisma();
  const owner = await prisma.user.create({
    data: { phone: `+9660009${Math.floor(Math.random() * 100000)}`, nameAr: 'م' },
  });
  await prisma.role.create({ data: { userId: owner.id, role: 'OWNER', scope: '' } });
  const prop = await prisma.property.create({
    data: {
      listingNumber: `L-REG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ownerId: owner.id,
      category: 'apartment',
      purpose: 'rent',
      status: 'available',
      advertisementLifecycle: 'PUBLISHED',
      publishedAt: new Date(),
      currency: 'SAR',
      // Hardened pricing policy: a DAILY_RENTAL booking against a
      // listing with no priceHalalahs is refused with 400. Seed one.
      priceHalalahs: BigInt(300 * 100),
      pricePeriod: 'DAY',
    },
  });
  return { ownerId: owner.id, propertyId: prop.id };
}

describe('error-handler shape — the setErrorHandler placement regression', () => {
  it('unauthenticated POST /v1/bookings → 401 UNAUTHORIZED (not 500)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: { 'content-type': 'application/json' },
      payload: {
        propertyId: 'cuid_doesnt_matter_here',
        transactionType: 'DAILY_RENTAL',
        grossAmount: '300',
        currency: 'SAR',
      },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe('UNAUTHORIZED');
    // The old (broken) default serializer injected the canned
    // "Internal Server Error" string + a top-level statusCode. Prove the
    // custom handler produced the body.
    expect(body).not.toHaveProperty('statusCode');
    expect(body.error).not.toBe('Internal Server Error');
  });

  it('invalid body on POST /v1/bookings → 400 VALIDATION with issues', async () => {
    const { token } = await makeCustomerToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      // Missing propertyId + transactionType; a 400 from Zod.
      payload: { currency: 'SAR' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('VALIDATION');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('overlapping dates → 409 CONFLICT (not 500)', async () => {
    const { propertyId } = await seedOwnerAndProperty();
    const { token, userId } = await makeCustomerToken();

    // Seed a confirmed booking that occupies 2027-02-10 .. 2027-02-13.
    const owner = await getPrisma().property.findUnique({ where: { id: propertyId }, select: { ownerId: true } });
    await getPrisma().booking.create({
      data: {
        propertyId,
        customerId: userId,
        hostId: owner!.ownerId,
        transactionType: 'DAILY_RENTAL',
        checkIn: new Date('2027-02-10T14:00:00Z'),
        checkOut: new Date('2027-02-13T12:00:00Z'),
        nights: 3,
        grossAmountHalalahs: halalahsFromMajor('900'),
        currency: 'SAR',
        status: 'confirmed',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      payload: {
        propertyId,
        transactionType: 'DAILY_RENTAL',
        grossAmount: '900',
        currency: 'SAR',
        nights: 3,
        // Overlaps the existing booking on 11–12 Feb.
        checkIn: '2027-02-11T14:00:00.000Z',
        checkOut: '2027-02-14T12:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('CONFLICT');
    expect(body.message).toContain('not available');
    expect(body).not.toHaveProperty('statusCode');
  });

  it('non-overlapping dates → 200 OK (sanity check)', async () => {
    const { propertyId } = await seedOwnerAndProperty();
    const { token } = await makeCustomerToken();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      payload: {
        propertyId,
        transactionType: 'DAILY_RENTAL',
        grossAmount: '600',
        currency: 'SAR',
        nights: 2,
        checkIn: '2027-05-01T14:00:00.000Z',
        checkOut: '2027-05-03T12:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.booking.status).toBe('draft');
  });
});
