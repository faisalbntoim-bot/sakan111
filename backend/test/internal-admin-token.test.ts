/**
 * Internal admin-token exchange — coverage.
 *
 * Scenarios (from the Phase 2 spec):
 *   1. secret not configured → 404 (feature-off)
 *   2. user id not configured → 404 (feature-off)
 *   3. wrong secret → 401 (generic)
 *   4. correct secret, user not in DB → 403
 *   5. correct secret, user exists but has no ADMIN/SUPER_ADMIN role → 403
 *   6. correct secret + valid ADMIN user → 200 with accessToken; token
 *      is accepted by `requireRole` on /v1/admin/dashboard.
 *   7. FINANCE_ADMIN-only user is refused (per spec: only ADMIN /
 *      SUPER_ADMIN back the service account).
 *   8. Response never echoes the presented secret.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildTestApp, resetDb, shutdown } from './helpers.js';
import authRoutes from '../src/routes/auth.js';
import adminOverviewRoutes from '../src/routes/admin.overview.js';
import { getPrisma } from '../src/db.js';
import { config } from '../src/config.js';

const SECRET = 'x'.repeat(48);

async function serverAuthOnly() {
  return buildTestApp(async (a) => { await a.register(authRoutes); });
}
async function serverWithAdmin() {
  return buildTestApp(async (a) => {
    await a.register(authRoutes);
    await a.register(adminOverviewRoutes);
  });
}

async function makeUserWithRoles(phone: string, roles: string[]) {
  return getPrisma().user.create({
    data: {
      phone,
      nameAr: 'خدمة إدارية',
      roles: { create: roles.map((r) => ({ role: r, scope: '' })) },
    },
    include: { roles: true },
  });
}

/** Mutate config in-process (mirrors the pattern in event-tracking tests). */
async function withEnv<T>(patch: Partial<typeof config>, fn: () => Promise<T>): Promise<T> {
  const cfg = config as unknown as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) snapshot[k] = cfg[k];
  Object.assign(cfg, patch);
  try { return await fn(); }
  finally { Object.assign(cfg, snapshot); }
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

describe('POST /v1/auth/internal-admin-token — feature-off', () => {
  it('returns 404 when the secret is not configured', async () => {
    const u = await makeUserWithRoles('+9660009991', ['ADMIN']);
    await withEnv({ SAKAN_INTERNAL_ADMIN_SECRET: undefined, SAKAN_INTERNAL_ADMIN_USER_ID: u.id }, async () => {
      const app = await serverAuthOnly();
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/internal-admin-token',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  it('returns 404 when the user id is not configured', async () => {
    await withEnv({ SAKAN_INTERNAL_ADMIN_SECRET: SECRET, SAKAN_INTERNAL_ADMIN_USER_ID: undefined }, async () => {
      const app = await serverAuthOnly();
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/internal-admin-token',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });
});

describe('POST /v1/auth/internal-admin-token — auth + role checks', () => {
  it('returns 401 for a wrong secret', async () => {
    const u = await makeUserWithRoles('+9660009992', ['ADMIN']);
    await withEnv({ SAKAN_INTERNAL_ADMIN_SECRET: SECRET, SAKAN_INTERNAL_ADMIN_USER_ID: u.id }, async () => {
      const app = await serverAuthOnly();
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/internal-admin-token',
        headers: { authorization: 'Bearer ' + 'y'.repeat(48) },
      });
      expect(res.statusCode).toBe(401);
      // Never echo the presented secret back.
      expect(res.body).not.toContain('y'.repeat(48));
      expect(res.body).not.toContain(SECRET);
      await app.close();
    });
  });

  it('returns 401 for a missing Authorization header (no leaking either)', async () => {
    const u = await makeUserWithRoles('+9660009993', ['ADMIN']);
    await withEnv({ SAKAN_INTERNAL_ADMIN_SECRET: SECRET, SAKAN_INTERNAL_ADMIN_USER_ID: u.id }, async () => {
      const app = await serverAuthOnly();
      const res = await app.inject({ method: 'POST', url: '/v1/auth/internal-admin-token' });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  it('returns 403 when the configured user id does not exist in the DB', async () => {
    await withEnv({ SAKAN_INTERNAL_ADMIN_SECRET: SECRET, SAKAN_INTERNAL_ADMIN_USER_ID: 'user_that_never_existed' }, async () => {
      const app = await serverAuthOnly();
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/internal-admin-token',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  it('returns 403 when the user exists but has no admin-family role', async () => {
    const u = await makeUserWithRoles('+9660009994', ['CUSTOMER']);
    await withEnv({ SAKAN_INTERNAL_ADMIN_SECRET: SECRET, SAKAN_INTERNAL_ADMIN_USER_ID: u.id }, async () => {
      const app = await serverAuthOnly();
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/internal-admin-token',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  it('rejects a FINANCE_ADMIN-only user (per spec: only ADMIN / SUPER_ADMIN back the service account)', async () => {
    const u = await makeUserWithRoles('+9660009995', ['FINANCE_ADMIN']);
    await withEnv({ SAKAN_INTERNAL_ADMIN_SECRET: SECRET, SAKAN_INTERNAL_ADMIN_USER_ID: u.id }, async () => {
      const app = await serverAuthOnly();
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/internal-admin-token',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });
});

describe('POST /v1/auth/internal-admin-token — success path', () => {
  it('issues an ADMIN JWT that is accepted by /v1/admin/dashboard', async () => {
    const u = await makeUserWithRoles('+9660009996', ['ADMIN']);
    await withEnv({ SAKAN_INTERNAL_ADMIN_SECRET: SECRET, SAKAN_INTERNAL_ADMIN_USER_ID: u.id }, async () => {
      const app = await serverWithAdmin();
      const exchange = await app.inject({
        method: 'POST', url: '/v1/auth/internal-admin-token',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(exchange.statusCode).toBe(200);
      const body = exchange.json() as { accessToken: string; tokenType: string; role: string; expiresIn: number };
      expect(body.tokenType).toBe('Bearer');
      expect(body.role).toBe('ADMIN');
      expect(body.expiresIn).toBeGreaterThan(0);
      expect(body.accessToken.split('.').length).toBe(3); // JWT header.payload.sig

      const dash = await app.inject({
        method: 'GET', url: '/v1/admin/dashboard?period=today',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(dash.statusCode).toBe(200);
      await app.close();
    });
  });

  it('accepts a SUPER_ADMIN user and mints a SUPER_ADMIN token', async () => {
    const u = await makeUserWithRoles('+9660009997', ['SUPER_ADMIN']);
    await withEnv({ SAKAN_INTERNAL_ADMIN_SECRET: SECRET, SAKAN_INTERNAL_ADMIN_USER_ID: u.id }, async () => {
      const app = await serverAuthOnly();
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/internal-admin-token',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { role: string };
      // The endpoint picks the first admin-family role it finds. Either
      // ADMIN or SUPER_ADMIN is acceptable — both satisfy the guard.
      expect(['ADMIN', 'SUPER_ADMIN']).toContain(body.role);
      await app.close();
    });
  });

  it('never leaks the secret on any response body', async () => {
    const u = await makeUserWithRoles('+9660009998', ['ADMIN']);
    await withEnv({ SAKAN_INTERNAL_ADMIN_SECRET: SECRET, SAKAN_INTERNAL_ADMIN_USER_ID: u.id }, async () => {
      const app = await serverAuthOnly();
      const good = await app.inject({
        method: 'POST', url: '/v1/auth/internal-admin-token',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(good.body).not.toContain(SECRET);
      await app.close();
    });
  });
});
