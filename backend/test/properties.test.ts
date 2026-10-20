import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, seedRules, shutdown, buildTestApp } from './helpers.js';
import propertyRoutes from '../src/routes/properties.js';
import bookingRoutes from '../src/routes/bookings.js';
import { getPrisma } from '../src/db.js';
import { halalahsFromMajor } from '../src/money.js';

async function server() {
  return buildTestApp(async (app) => {
    await app.register(propertyRoutes);
    await app.register(bookingRoutes);
  });
}

beforeEach(async () => { await resetDb(); await seedRules(); });
afterAll(async () => { await shutdown(); });

async function seedInventory() {
  const prisma = getPrisma();
  const owner = await prisma.user.create({ data: { phone: '+9660201', nameAr: 'مالك' } });
  const props = [] as unknown[];
  for (let i = 0; i < 25; i++) {
    props.push(await prisma.property.create({
      data: {
        listingNumber: `L-${i.toString().padStart(4, '0')}`,
        ownerId: owner.id,
        category: i % 2 === 0 ? 'apartment' : 'villa',
        purpose: 'daily',
        status: i < 20 ? 'available' : 'hidden',
        // Hardened pricing policy: a listing without priceHalalahs is
        // not bookable as a daily rental. Seed a nominal daily rate.
        priceHalalahs: BigInt(300 * 100),
        pricePeriod: 'DAY',
      },
    }));
  }
  return { owner, props };
}

describe('GET /v1/properties — list', () => {
  it('paginates and hides non-available listings from anonymous callers', async () => {
    await seedInventory();
    const app = await server();
    const page1 = await app.inject({ method: 'GET', url: '/v1/properties?page=1&pageSize=10' });
    expect(page1.statusCode).toBe(200);
    const body = page1.json();
    expect(body.items.length).toBe(10);
    expect(body.total).toBe(20);           // hidden ones excluded
    // Ownerless / officeId not leaked to anonymous callers.
    expect(body.items[0].ownerId).toBeUndefined();
    expect(body.items[0].officeId).toBeUndefined();
    await app.close();
  });

  it('admin sees hidden listings and full owner info', async () => {
    const { owner } = await seedInventory();
    const app = await server();
    const res = await app.inject({
      method: 'GET', url: '/v1/properties?status=hidden',
      headers: { 'x-user-id': owner.id, 'x-user-role': 'ADMIN' },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.length).toBe(5);
    expect(items[0].ownerId).toBe(owner.id);
    await app.close();
  });

  it('filters by category', async () => {
    await seedInventory();
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/properties?category=villa&pageSize=50' });
    expect(res.json().items.every((p: { category: string }) => p.category === 'villa')).toBe(true);
    await app.close();
  });
});

describe('GET /v1/properties/:id — visibility', () => {
  it('returns 404 for a hidden listing to non-owner', async () => {
    const { props } = await seedInventory();
    const hidden = props[20] as { id: string };
    const app = await server();
    const res = await app.inject({ method: 'GET', url: `/v1/properties/${hidden.id}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('owner can read their own hidden listing with owner-only fields', async () => {
    const { owner, props } = await seedInventory();
    const hidden = props[20] as { id: string };
    const app = await server();
    const res = await app.inject({
      method: 'GET', url: `/v1/properties/${hidden.id}`,
      headers: { 'x-user-id': owner.id, 'x-user-role': 'HOST' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ownerId).toBe(owner.id);
    await app.close();
  });
});

describe('GET /v1/properties/:id/availability', () => {
  it('reports the property as available when no bookings overlap', async () => {
    const { props } = await seedInventory();
    const p = props[0] as { id: string };
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/properties/${p.id}/availability?from=2026-09-01T00:00:00.000Z&to=2026-09-10T00:00:00.000Z`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isAvailable).toBe(true);
    await app.close();
  });

  it('reports booked ranges when a confirmed booking exists', async () => {
    const prisma = getPrisma();
    const { owner, props } = await seedInventory();
    const p = props[0] as { id: string };
    const customer = await prisma.user.create({ data: { phone: '+9660299', nameAr: 'ضيف' } });
    await prisma.booking.create({
      data: {
        propertyId: p.id, customerId: customer.id, hostId: owner.id,
        transactionType: 'DAILY_RENTAL',
        checkIn: new Date('2026-09-05T14:00:00Z'),
        checkOut: new Date('2026-09-08T11:00:00Z'),
        grossAmountHalalahs: halalahsFromMajor('900'),
        currency: 'SAR', status: 'confirmed',
      },
    });
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/properties/${p.id}/availability?from=2026-09-01T00:00:00.000Z&to=2026-09-10T00:00:00.000Z`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isAvailable).toBe(false);
    expect(res.json().bookedRanges).toHaveLength(1);
    await app.close();
  });
});

describe('POST /v1/bookings — availability guard (B7)', () => {
  it('rejects a second overlapping booking with 409', async () => {
    const prisma = getPrisma();
    const { owner, props } = await seedInventory();
    const p = props[0] as { id: string };
    const customerA = await prisma.user.create({ data: { phone: '+9660301', nameAr: 'ضيف أ' } });
    const customerB = await prisma.user.create({ data: { phone: '+9660302', nameAr: 'ضيف ب' } });
    // Existing confirmed booking.
    await prisma.booking.create({
      data: {
        propertyId: p.id, customerId: customerA.id, hostId: owner.id,
        transactionType: 'DAILY_RENTAL',
        checkIn: new Date('2026-10-01T14:00:00Z'),
        checkOut: new Date('2026-10-05T11:00:00Z'),
        grossAmountHalalahs: halalahsFromMajor('1200'),
        currency: 'SAR', status: 'confirmed',
      },
    });

    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/bookings',
      payload: {
        propertyId: p.id, transactionType: 'DAILY_RENTAL',
        grossAmount: '600', currency: 'SAR', nights: 2,
        checkIn:  '2026-10-03T14:00:00.000Z',
        checkOut: '2026-10-06T11:00:00.000Z',
      },
      headers: {
        'content-type': 'application/json',
        'x-user-id': customerB.id, 'x-user-role': 'CUSTOMER',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/not available/i);
    await app.close();
  });

  it('rejects a booking whose currency does not match the property', async () => {
    const prisma = getPrisma();
    const { props } = await seedInventory();
    const p = props[0] as { id: string };
    const customer = await prisma.user.create({ data: { phone: '+9660303', nameAr: 'ضيف' } });

    const app = await server();
    const res = await app.inject({
      method: 'POST', url: '/v1/bookings',
      payload: { propertyId: p.id, transactionType: 'DAILY_RENTAL', grossAmount: '100', currency: 'USD' },
      headers: {
        'content-type': 'application/json',
        'x-user-id': customer.id, 'x-user-role': 'CUSTOMER',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/currency/i);
    await app.close();
  });
});
