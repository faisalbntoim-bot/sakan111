#!/usr/bin/env node
/**
 * Fixture seed for the real-backend browser E2E test.
 *
 * Creates:
 *   - owner user + OWNER role
 *   - admin user + ADMIN role
 *   - one DRAFT property owned by the owner
 *
 * Writes `.e2e-state.json` next to the script with the IDs and the
 * minted JWTs. The test spec reads this file to drive the browser
 * and the admin API calls.
 *
 * This is pure fixture setup — no advertisementLifecycle transitions
 * happen here. Every transition the test observes flows through an
 * HTTP endpoint.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { PrismaClient } from '../../../backend/node_modules/@prisma/client/index.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ISSUER = process.env.JWT_ISSUER || 'sakanhub-backend';
if (!JWT_SECRET) { console.error('JWT_SECRET env required'); process.exit(2); }

const prisma = new PrismaClient();

const ownerPhone = '+9660099990';
const adminPhone = '+9660099991';

async function main() {
  const owner = await prisma.user.upsert({
    where: { phone: ownerPhone },
    update: { nameAr: 'مالك e2e' },
    create: { phone: ownerPhone, nameAr: 'مالك e2e' },
  });
  if (!(await prisma.role.findFirst({ where: { userId: owner.id, role: 'OWNER' } }))) {
    await prisma.role.create({ data: { userId: owner.id, role: 'OWNER' } });
  }
  const admin = await prisma.user.upsert({
    where: { phone: adminPhone },
    update: { nameAr: 'مشرف e2e' },
    create: { phone: adminPhone, nameAr: 'مشرف e2e' },
  });
  if (!(await prisma.role.findFirst({ where: { userId: admin.id, role: 'ADMIN' } }))) {
    await prisma.role.create({ data: { userId: admin.id, role: 'ADMIN' } });
  }
  // Fresh DRAFT property for this run (unique listingNumber per invocation).
  // listingNumber + district both carry the same run-unique suffix so
  // the public /ar card can be identified by district alone (no demo
  // district collides with it; stale e2e runs in the same DB don't
  // either). Playwright uses `district` as the scoping locator.
  const runStamp = Date.now();
  const listingNumber = 'E2E-' + runStamp;
  const district = 'حي E2E-' + runStamp;
  const prop = await prisma.property.create({
    data: {
      listingNumber,
      ownerId: owner.id,
      category: 'apartment', purpose: 'rent',
      advertisementLifecycle: 'DRAFT',
      city: 'الرياض', district,
      areaSqm: 120, bedrooms: 3, bathrooms: 2,
      priceHalalahs: BigInt(2500000),
    },
  });

  function mint(sub, role) {
    const out = execFileSync('node', [path.join(here, 'mint-jwt.mjs'), sub, role, JWT_ISSUER, JWT_SECRET, '1800'], { encoding: 'utf8' });
    return out.trim();
  }
  const state = {
    jwtSecret: JWT_SECRET,
    owner: { id: owner.id, token: mint(owner.id, 'OWNER') },
    admin: { id: admin.id, token: mint(admin.id, 'ADMIN') },
    property: { id: prop.id, listingNumber, district },
  };
  fs.writeFileSync(path.join(here, '.e2e-state.json'), JSON.stringify(state, null, 2));
  console.log('seeded:', state.owner.id, '/', state.admin.id, '/', state.property.id);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
