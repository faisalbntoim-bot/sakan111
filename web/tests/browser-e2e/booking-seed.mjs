#!/usr/bin/env node
/**
 * Fixture seed for the UI-driven booking E2E spec (booking-ui.spec.ts).
 *
 * Creates:
 *   - owner user + OWNER role + ONE PUBLISHED property so a customer
 *     can land on /ar/properties/<cuid>/booking without an admin
 *     dance.
 *   - four customer phones (one per spec test, to dodge the per-phone
 *     OTP rate limit of 3 challenges per 10 minutes).
 *   - a CONFIRMED booking on a KNOWN window (today + 20 → today + 23
 *     UTC) for the overlap test. The spec reads that window from the
 *     seed state file and picks the SAME days by day-of-month on the
 *     calendar, so the overlap test does not depend on any earlier
 *     test having run.
 *
 * Each test uses its own date window (listed in `windows` in the seed
 * file); all windows are mutually non-overlapping so the four tests
 * can run in any order without colliding on seat availability.
 *
 * Writes .booking-e2e-state.json alongside this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { PrismaClient } from '../../../backend/node_modules/@prisma/client/index.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

const ownerPhone = '+9660088880';
const customerPhones = {
  happyPath:    '+9660088881',
  doubleClick:  '+9660088882',
  overlap:      '+9660088883',
  failureRetry: '+9660088884',
};

/** Pure date-arithmetic helper; UTC to match the server. The seed and
 *  spec use `plusDays(todayUtc, n)` so they agree on which cell on the
 *  calendar corresponds to each window. */
function todayUtcMidnight() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function plusDaysUtc(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function ymdUtc(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function main() {
  const owner = await prisma.user.upsert({
    where: { phone: ownerPhone },
    update: { nameAr: 'مالك booking-e2e' },
    create: { phone: ownerPhone, nameAr: 'مالك booking-e2e' },
  });
  if (!(await prisma.role.findFirst({ where: { userId: owner.id, role: 'OWNER' } }))) {
    await prisma.role.create({ data: { userId: owner.id, role: 'OWNER' } });
  }

  // Pre-create each customer so the first UI OTP flow does not race
  // the auto-signup path.
  for (const phone of Object.values(customerPhones)) {
    await prisma.user.upsert({
      where: { phone },
      update: { nameAr: 'عميل booking-e2e' },
      create: {
        phone,
        nameAr: 'عميل booking-e2e',
        roles: { create: { role: 'CUSTOMER', scope: '' } },
      },
    });
  }

  // Pre-create ONE EXTRA customer whose booking occupies the overlap
  // test's target window. The overlap test's own customer will crash
  // into THIS booking, not into another test's happy-path booking.
  const overlapHolderPhone = '+9660088885';
  const overlapHolder = await prisma.user.upsert({
    where: { phone: overlapHolderPhone },
    update: { nameAr: 'حاجز متداخل booking-e2e' },
    create: {
      phone: overlapHolderPhone,
      nameAr: 'حاجز متداخل booking-e2e',
      roles: { create: { role: 'CUSTOMER', scope: '' } },
    },
  });

  const runStamp = Date.now();
  const listingNumber = 'BK-E2E-' + runStamp;
  const district = 'حي BK-E2E-' + runStamp;
  const prop = await prisma.property.create({
    data: {
      listingNumber,
      ownerId: owner.id,
      category: 'apartment',
      purpose: 'rent',
      status: 'available',
      advertisementLifecycle: 'PUBLISHED',
      publishedAt: new Date(),
      currency: 'SAR',
      city: 'الرياض',
      district,
      areaSqm: 140,
      bedrooms: 3,
      bathrooms: 2,
      priceHalalahs: BigInt(9600 * 100),   // 9600 SAR / month → 320 SAR / night
      pricePeriod: 'MONTH',
      furnished: true,
    },
  });

  // Date windows (UTC). Non-overlapping so tests do not collide
  // regardless of execution order.
  const today = todayUtcMidnight();
  const windows = {
    happyPath:    { startOffsetDays: 2,  nights: 2 },
    doubleClick:  { startOffsetDays: 10, nights: 2 },
    overlap:      { startOffsetDays: 20, nights: 3 },  // pre-booked below
    failureRetry: { startOffsetDays: 30, nights: 2 },
  };
  const resolved = Object.fromEntries(Object.entries(windows).map(([k, w]) => {
    const start = plusDaysUtc(today, w.startOffsetDays);
    const end   = plusDaysUtc(today, w.startOffsetDays + w.nights);
    return [k, {
      startOffsetDays: w.startOffsetDays,
      nights: w.nights,
      checkIn: start.toISOString(),
      checkOut: end.toISOString(),
      checkInYmd: ymdUtc(start),
      checkOutYmd: ymdUtc(end),
    }];
  }));

  // Pre-book the overlap window so the overlap test's attempt crashes
  // into THIS row, not into any sibling test's happy-path booking.
  await prisma.booking.create({
    data: {
      propertyId: prop.id,
      customerId: overlapHolder.id,
      hostId: owner.id,
      transactionType: 'DAILY_RENTAL',
      checkIn: new Date(resolved.overlap.checkIn),
      checkOut: new Date(resolved.overlap.checkOut),
      nights: resolved.overlap.nights,
      grossAmountHalalahs: BigInt(960 * 100),
      currency: 'SAR',
      status: 'confirmed',
      confirmedAt: new Date(),
    },
  });

  const state = {
    ownerPhone,
    customerPhones,
    property: { id: prop.id, listingNumber, district },
    windows: resolved,
  };
  fs.writeFileSync(path.join(here, '.booking-e2e-state.json'), JSON.stringify(state, null, 2));
  console.log('booking seed:', state.property.id);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
