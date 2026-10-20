/**
 * Multi-process concurrency test.
 *
 * The in-process mutex has been removed in favour of a DB-level write
 * lock (`UPDATE Property SET updatedAt=NOW()` is the first write
 * inside the transaction). This test proves the guard holds across
 * two SEPARATE processes talking to the same database — the scenario
 * a production load balancer creates and the in-process mutex cannot
 * defend against.
 *
 * We spawn one `tsx` worker and run the identical critical section in
 * the parent, race them, and assert exactly one commits.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { resetDb, shutdown } from './helpers.js';
import { getPrisma } from '../src/db.js';
import { halalahsFromMajor } from '../src/money.js';

beforeAll(async () => { /* uses shared prisma from helpers */ });
afterAll(async () => { await shutdown(); });
beforeEach(async () => { await resetDb(); });

async function seedPropertyAndTwoCustomers() {
  const prisma = getPrisma();
  const owner = await prisma.user.create({ data: { phone: `+96601${Date.now()}`, nameAr: 'م' } });
  const prop = await prisma.property.create({
    data: {
      listingNumber: `L-MP-${Date.now()}`,
      ownerId: owner.id, category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'PUBLISHED', publishedAt: new Date(),
      currency: 'SAR', priceHalalahs: BigInt(9_000_00), pricePeriod: 'MONTH',
    },
  });
  const alice = await prisma.user.create({ data: { phone: `+96602${Date.now()}a`, nameAr: 'أ' } });
  const bob   = await prisma.user.create({ data: { phone: `+96602${Date.now()}b`, nameAr: 'ب' } });
  return { propertyId: prop.id, hostId: owner.id, aliceId: alice.id, bobId: bob.id };
}

function runWorker(job: Record<string, unknown>): { ready: Promise<void>; done: Promise<'ok' | 'conflict'>; go: () => void } {
  const scriptPath = path.join(__dirname, 'booking-concurrent-process.worker.ts');
  const encoded = Buffer.from(JSON.stringify(job)).toString('base64');
  // Use the project's local tsx so the worker runs the TypeScript file
  // directly without a separate build step.
  const tsxBin = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const child = spawn(tsxBin, [scriptPath, encoded], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let readyRes!: () => void;
  const ready = new Promise<void>((r) => { readyRes = r; });
  let doneRes!: (v: 'ok' | 'conflict') => void;
  let doneRej!: (e: unknown) => void;
  const done = new Promise<'ok' | 'conflict'>((r, rj) => { doneRes = r; doneRej = rj; });

  child.stdout.on('data', (buf) => {
    const text = buf.toString();
    if (text.includes('READY')) readyRes();
    if (text.includes('DONE ok')) doneRes('ok');
    if (text.includes('DONE conflict')) doneRes('conflict');
  });
  child.stderr.on('data', (buf) => process.stderr.write(`[worker] ${buf.toString()}`));
  child.on('exit', (code) => {
    if (code === 0) doneRes('ok');
    else if (code === 1) doneRes('conflict');
    else doneRej(new Error(`worker exited with code ${code}`));
  });

  return {
    ready,
    done,
    go: () => { child.stdin.write('GO\n'); child.stdin.end(); },
  };
}

describe('cross-process concurrency — DB-level write lock serialises', () => {
  it('two independent processes race the same window → exactly one commits, the other sees overlap', async () => {
    const { propertyId, hostId, aliceId, bobId } = await seedPropertyAndTwoCustomers();
    const window = {
      checkIn:  '2029-02-01T14:00:00.000Z',
      checkOut: '2029-02-03T12:00:00.000Z',
      nights: 2,
      grossMajor: '600', // 300/night × 2 nights (9000/30 → 300)
    };

    const alice = runWorker({ propertyId, customerId: aliceId, hostId, ...window });
    const bob   = runWorker({ propertyId, customerId: bobId,   hostId, ...window });

    await Promise.all([alice.ready, bob.ready]);
    // Both children are at the GO barrier. Fire them in the same
    // microtask so they truly race.
    alice.go();
    bob.go();
    const [aliceOutcome, bobOutcome] = await Promise.all([alice.done, bob.done]);

    const outcomes = [aliceOutcome, bobOutcome].sort();
    expect(outcomes).toEqual(['conflict', 'ok']);

    // DB side: exactly one booking row for this property, in draft.
    const rows = await getPrisma().booking.findMany({ where: { propertyId } });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('draft');
  }, 30_000);
});
