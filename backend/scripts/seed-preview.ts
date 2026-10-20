/**
 * scripts/seed-preview.ts — deterministic seed for the local preview.
 *
 * Creates THREE named users with the three roles the app recognises
 * (OWNER, ADMIN, CUSTOMER), and one PUBLISHED property owned by the
 * owner. Login still uses the real OTP flow — this script does NOT
 * plant a well-known code; the code is printed by the console SMS
 * adapter in the backend log.
 *
 * The roles are explicit: logging in with a phone that has NOT been
 * assigned a role returns the DEFAULT role (CUSTOMER). The admin and
 * owner privileges require pre-existing Role rows — THIS SCRIPT is
 * where they come from in a preview. In production, admins are
 * provisioned by a separate, audited flow (not covered here).
 */

import { getPrisma } from '../src/db.js';

type SeedUser = { phone: string; nameAr: string; role: 'OWNER' | 'ADMIN' | 'CUSTOMER' };

const USERS: SeedUser[] = [
  { phone: process.env.SEED_OWNER_PHONE    || '+9660001000', nameAr: 'مالك تجريبي',    role: 'OWNER' },
  { phone: process.env.SEED_ADMIN_PHONE    || '+9660003000', nameAr: 'مشرف تجريبي',    role: 'ADMIN' },
  { phone: process.env.SEED_CUSTOMER_PHONE || '+9660002000', nameAr: 'مستخدم تجريبي',  role: 'CUSTOMER' },
];

async function main() {
  const prisma = getPrisma();
  const seeded: Array<SeedUser & { id: string }> = [];

  for (const u of USERS) {
    const user = await prisma.user.upsert({
      where: { phone: u.phone },
      update: { nameAr: u.nameAr },
      create: { phone: u.phone, nameAr: u.nameAr },
    });
    const existing = await prisma.role.findFirst({ where: { userId: user.id, role: u.role } });
    if (!existing) {
      await prisma.role.create({ data: { userId: user.id, role: u.role } });
    }
    seeded.push({ ...u, id: user.id });
  }

  const owner = seeded.find((u) => u.role === 'OWNER')!;

  const listingNumber = 'L-PREVIEW-1';
  const now = new Date();
  const prop = await prisma.property.upsert({
    where: { listingNumber },
    update: {
      ownerId: owner.id,
      status: 'available',
      advertisementLifecycle: 'PUBLISHED',
      publishedAt: now,
    },
    create: {
      listingNumber,
      ownerId: owner.id,
      category: 'apartment',
      purpose: 'rent',
      status: 'available',
      advertisementLifecycle: 'PUBLISHED',
      publishedAt: now,
      areaSqm: 140,
      bedrooms: 3,
      bathrooms: 2,
      // Priced per MONTH so the preview exercises the policy of
      // deriving a daily rate when BOOKING_ALLOW_MONTHLY_TO_DAILY=true.
      priceHalalahs: BigInt(9_600_00), // 9600 SAR / month → 320 SAR / night
      pricePeriod: 'MONTH',
      furnished: true,
      city: 'الرياض',
      district: 'حي النرجس',
    },
  });

  const line = '─'.repeat(60);
  console.log(line);
  console.log('Preview seed — users (role is NOT inferred from phone):');
  console.log(line);
  for (const u of seeded) {
    console.log(`  ${u.role.padEnd(8)}  phone=${u.phone}  name="${u.nameAr}"  id=${u.id}`);
  }
  console.log();
  console.log(`  Property  listingNumber=${listingNumber}  id=${prop.id}  city=الرياض/حي النرجس`);
  console.log(line);
  console.log('Login flow (real OTP via console SMS adapter):');
  console.log('  1. Open /ar/owner/login or /ar/admin/login in your browser.');
  console.log('  2. Enter the phone that matches the role you need.');
  console.log('  3. Watch the backend TERMINAL for a line like:');
  console.log('        [sms:console] +9660001000 ← SakanHub verification code: 123456');
  console.log('     That line is the ONLY place the code is written. It is');
  console.log('     NEVER written to a file or persisted anywhere.');
  console.log('  4. Enter the six digits on the UI.');
  console.log(line);
  console.log('Role rules — short:');
  console.log('  * OWNER phone  + /ar/owner/login → edit own property, upload media, submit for review');
  console.log('  * ADMIN phone  + /ar/admin/login → publish properties, read orphan payments');
  console.log('  * CUSTOMER     + /ar/*           → book + pay (sandbox) only');
  console.log('  * Any phone NOT in this seed logs in as the DEFAULT CUSTOMER role.');
  console.log('  * Logging in with a phone does NOT grant admin or owner by itself.');
  console.log(line);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
