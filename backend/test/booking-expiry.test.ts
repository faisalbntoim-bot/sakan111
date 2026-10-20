import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, shutdown } from './helpers.js';
import { runBookingExpirySweep } from '../src/workers/booking-expiry.js';
import { getPrisma } from '../src/db.js';
import { halalahsFromMajor } from '../src/money.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

let phoneSeq = 0;
function uniquePhone(prefix: string): string {
  phoneSeq += 1;
  return `${prefix}${String(phoneSeq).padStart(6, '0')}`;
}

async function seedBooking(status: string, ageMinutes: number, opts?: { paymentStatus?: string }) {
  const prisma = getPrisma();
  const host = await prisma.user.create({ data: { phone: uniquePhone('+96605'), nameAr: 'م' } });
  const cust = await prisma.user.create({ data: { phone: uniquePhone('+96606'), nameAr: 'ع' } });
  const suffix = Math.random().toString(36).slice(2, 8);
  const p = await prisma.property.create({
    data: { listingNumber: `L-${suffix}`, ownerId: host.id, category: 'apartment', purpose: 'daily' },
  });
  const createdAt = new Date(Date.now() - ageMinutes * 60 * 1000);
  const b = await prisma.booking.create({
    data: {
      propertyId: p.id, customerId: cust.id, hostId: host.id,
      transactionType: 'DAILY_RENTAL', grossAmountHalalahs: halalahsFromMajor('300'),
      currency: 'SAR', status,
      createdAt,
    },
  });
  if (opts?.paymentStatus) {
    await prisma.payment.create({
      data: {
        bookingId: b.id, type: 'CHARGE', grossAmountHalalahs: halalahsFromMajor('317.25'),
        currency: 'SAR', status: opts.paymentStatus, provider: 'sandbox',
        idempotencyKey: `idem-${b.id}`,
      },
    });
  }
  return b;
}

describe('booking-expiry worker', () => {
  it('cancels a pending_payment booking older than the TTL', async () => {
    const b = await seedBooking('pending_payment', 45, { paymentStatus: 'pending' });
    const result = await runBookingExpirySweep({ ttlMinutes: 30 });
    expect(result.cancelled).toContain(b.id);
    const after = await getPrisma().booking.findUnique({ where: { id: b.id } });
    expect(after?.status).toBe('cancelled');
    const p = await getPrisma().payment.findFirst({ where: { bookingId: b.id } });
    expect(p?.status).toBe('cancelled');
  });

  it('leaves a fresh pending_payment booking alone', async () => {
    const b = await seedBooking('pending_payment', 10, { paymentStatus: 'pending' });
    const result = await runBookingExpirySweep({ ttlMinutes: 30 });
    expect(result.cancelled).not.toContain(b.id);
    const after = await getPrisma().booking.findUnique({ where: { id: b.id } });
    expect(after?.status).toBe('pending_payment');
  });

  it('NEVER cancels a booking whose payment is captured (even if old)', async () => {
    const b = await seedBooking('pending_payment', 90, { paymentStatus: 'captured' });
    const result = await runBookingExpirySweep({ ttlMinutes: 30 });
    expect(result.cancelled).not.toContain(b.id);
    const after = await getPrisma().booking.findUnique({ where: { id: b.id } });
    expect(after?.status).toBe('pending_payment');
  });

  it('is idempotent — running twice does not re-cancel or double-audit-effect', async () => {
    const b = await seedBooking('pending_payment', 60, { paymentStatus: 'pending' });
    const first = await runBookingExpirySweep({ ttlMinutes: 30 });
    const second = await runBookingExpirySweep({ ttlMinutes: 30 });
    expect(first.cancelled).toContain(b.id);
    expect(second.cancelled).not.toContain(b.id);       // already cancelled — no re-work
  });

  it('leaves confirmed bookings alone (never swept, regardless of age)', async () => {
    const bc = await seedBooking('confirmed', 120);
    const result = await runBookingExpirySweep({ ttlMinutes: 30, draftTtlMinutes: 15 });
    expect(result.cancelled).not.toContain(bc.id);
  });

  it('cancels drafts older than draftTtlMinutes so their dates free up', async () => {
    const bd = await seedBooking('draft', 60); // 60 min old, draftTtl=15
    const result = await runBookingExpirySweep({ draftTtlMinutes: 15, pendingTtlMinutes: 30 });
    expect(result.cancelled).toContain(bd.id);
    const after = await getPrisma().booking.findUnique({ where: { id: bd.id } });
    expect(after?.status).toBe('cancelled');
  });

  it('leaves a fresh draft (< draftTtlMinutes) alone', async () => {
    const bd = await seedBooking('draft', 5); // 5 min old, draftTtl=15
    const result = await runBookingExpirySweep({ draftTtlMinutes: 15, pendingTtlMinutes: 30 });
    expect(result.cancelled).not.toContain(bd.id);
    const after = await getPrisma().booking.findUnique({ where: { id: bd.id } });
    expect(after?.status).toBe('draft');
  });
});
