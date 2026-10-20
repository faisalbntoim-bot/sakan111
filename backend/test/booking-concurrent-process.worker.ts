/**
 * Worker script for the multi-process concurrency test.
 *
 * Spawned by booking-concurrent-process.test.ts via fork(). Opens its
 * OWN Prisma client, waits for a start signal, then races the critical
 * section — property-row UPDATE → overlap check → booking insert —
 * against the parent process.
 *
 * Exit code 0 = booking committed. Exit code 1 = conflict (overlap /
 * unique constraint / SQLITE_BUSY retry exhausted). Any other code is
 * an unexpected error.
 */

import { PrismaClient } from '@prisma/client';
import { halalahsFromMajor } from '../src/money.js';

type JobInput = {
  propertyId: string;
  customerId: string;
  hostId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  grossMajor: string;
};

const [,, encoded] = process.argv;
if (!encoded) { console.error('missing job'); process.exit(2); }
const job = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as JobInput;

const prisma = new PrismaClient();

async function attempt(): Promise<'ok' | 'conflict'> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.property.update({
        where: { id: job.propertyId },
        data: { updatedAt: new Date() },
      });
      const checkIn  = new Date(job.checkIn);
      const checkOut = new Date(job.checkOut);
      const overlap = await tx.booking.findFirst({
        where: {
          propertyId: job.propertyId,
          status: { in: ['draft', 'pending_payment', 'confirmed'] },
          AND: [{ checkIn: { lt: checkOut } }, { checkOut: { gt: checkIn } }],
        },
      });
      if (overlap) throw new Error('OVERLAP');
      await tx.booking.create({
        data: {
          propertyId: job.propertyId,
          customerId: job.customerId,
          hostId: job.hostId,
          transactionType: 'DAILY_RENTAL',
          checkIn, checkOut,
          nights: job.nights,
          grossAmountHalalahs: halalahsFromMajor(job.grossMajor),
          currency: 'SAR',
          status: 'draft',
        },
      });
    });
    return 'ok';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'OVERLAP' || /SQLITE_BUSY|database is locked/i.test(msg)) {
      return 'conflict';
    }
    throw e;
  }
}

(async () => {
  // Signal readiness so the parent can time the race.
  process.stdout.write('READY\n');
  // The parent writes 'GO\n' when it wants both to proceed. We race
  // this child with the parent's in-process attempt by having the
  // parent write GO after both are READY.
  await new Promise<void>((resolve) => {
    process.stdin.on('data', (chunk) => {
      if (chunk.toString().includes('GO')) resolve();
    });
  });
  try {
    const outcome = await attempt();
    process.stdout.write(`DONE ${outcome}\n`);
    await prisma.$disconnect();
    process.exit(outcome === 'ok' ? 0 : 1);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`ERROR ${msg}\n`);
    await prisma.$disconnect();
    process.exit(3);
  }
})();
