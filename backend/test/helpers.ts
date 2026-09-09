import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { getPrisma, disconnect } from '../src/db.js';
import { halalahsFromMajor } from '../src/money.js';

/** Test-scoped Fastify with the same error handler main.ts installs.
 *  Uses duck-typing on `httpStatus` so cross-module `instanceof` doesn't matter under vitest. */
export async function buildTestApp(register: (app: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { httpStatus?: number; code?: string; message?: string; details?: unknown; name?: string };
    if (typeof e.httpStatus === 'number') {
      return reply.code(e.httpStatus).send({ error: e.code, message: e.message, details: e.details });
    }
    if (err instanceof ZodError || e.name === 'ZodError') {
      return reply.code(400).send({ error: 'VALIDATION', issues: (err as ZodError).issues });
    }
    return reply.code(500).send({ error: 'INTERNAL', message: 'internal server error' });
  });
  await register(app);
  await app.ready();
  return app;
}

export async function resetDb() {
  const prisma = getPrisma();
  // Order matters: children first.
  await prisma.$transaction([
    prisma.ledgerEntry.deleteMany(),
    prisma.account.deleteMany(),
    prisma.paymentEvent.deleteMany(),
    prisma.refund.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.settlement.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.webhookEvent.deleteMany(),
    prisma.bookingItem.deleteMany(),
    prisma.booking.deleteMany(),
    prisma.propertyHost.deleteMany(),
    prisma.property.deleteMany(),
    prisma.beneficiary.deleteMany(),
    prisma.role.deleteMany(),
    prisma.kyc.deleteMany(),
    prisma.user.deleteMany(),
    prisma.commissionRule.deleteMany(),
    prisma.taxRule.deleteMany(),
    prisma.adProduct.deleteMany(),
    prisma.subscriptionPlan.deleteMany(),
    prisma.subscription.deleteMany(),
    prisma.advertisement.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.idempotencyKey.deleteMany(),
    prisma.taxRecord.deleteMany(),
    prisma.otpChallenge.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.complaint.deleteMany(),
    prisma.advertiserVerification.deleteMany(),
    prisma.tourHotspot.deleteMany(),
    prisma.propertyTour.deleteMany(),
    prisma.mediaProcessingJob.deleteMany(),
    prisma.mediaAsset.deleteMany(),
  ]);
}

export async function seedRules() {
  const prisma = getPrisma();
  await prisma.commissionRule.create({
    data: { transactionType: 'DAILY_RENTAL', platformPercentage: 5, priority: 10 },
  });
  await prisma.commissionRule.create({
    data: { transactionType: 'SALE', platformPercentage: 2.5, officePercentage: 40, marketerPercentage: 10, priority: 10 },
  });
  await prisma.commissionRule.create({
    data: { transactionType: 'COMMERCIAL_RENTAL', platformPercentage: 3, officePercentage: 30, marketerPercentage: 10, priority: 10 },
  });

  await prisma.taxRule.create({ data: { serviceType: 'RENTAL_RESIDENTIAL', ratePercent: 0, taxable: false, reasonCode: 'SA_VAT_RESIDENTIAL_EXEMPT' } });
  await prisma.taxRule.create({ data: { serviceType: 'RENTAL_COMMERCIAL', ratePercent: 15, taxable: true } });
  await prisma.taxRule.create({ data: { serviceType: 'PLATFORM_FEE', ratePercent: 15, taxable: true } });
  await prisma.taxRule.create({ data: { serviceType: 'BROKERAGE', ratePercent: 15, taxable: true } });
}

export async function makeUsers() {
  const prisma = getPrisma();
  const host = await prisma.user.create({ data: { phone: '+9660001', nameAr: 'مضيف' } });
  const customer = await prisma.user.create({ data: { phone: '+9660002', nameAr: 'عميل' } });
  return { host, customer };
}

export async function makeDailyRentalBooking(opts: { grossMajor: string | number }) {
  const prisma = getPrisma();
  const { host, customer } = await makeUsers();
  const property = await prisma.property.create({
    data: { listingNumber: `L-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ownerId: host.id, category: 'apartment', purpose: 'daily' },
  });
  await prisma.propertyHost.create({ data: { propertyId: property.id, hostId: host.id, isPrimary: true } });
  const booking = await prisma.booking.create({
    data: {
      propertyId: property.id,
      customerId: customer.id,
      hostId: host.id,
      transactionType: 'DAILY_RENTAL',
      grossAmountHalalahs: halalahsFromMajor(opts.grossMajor),
      currency: 'SAR',
      status: 'draft',
    },
  });
  return { host, customer, property, booking };
}

export async function shutdown() {
  await disconnect();
}
