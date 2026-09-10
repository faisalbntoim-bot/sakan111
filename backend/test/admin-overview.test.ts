/**
 * /v1/admin/dashboard auth-guard tests.
 *
 * Uses buildTestApp (matches every other suite) so the shared error
 * handler + resetDb hygiene apply. Focus: security contract — only
 * an admin role reads the aggregate, and error responses don't leak
 * data.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { buildTestApp, resetDb, shutdown } from './helpers.js';
import adminOverviewRoutes from '../src/routes/admin.overview.js';

async function server() {
  return buildTestApp(async (a) => { await a.register(adminOverviewRoutes); });
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

describe('GET /v1/admin/dashboard — auth guard', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/dashboard' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('user');
    expect(body).not.toHaveProperty('data');
    await app.close();
  });

  it('rejects regular CUSTOMER role with 403', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/dashboard',
      headers: { 'x-user-id': 'u_customer', 'x-user-role': 'CUSTOMER' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects OWNER role with 403 (owner is not an admin role)', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/dashboard',
      headers: { 'x-user-id': 'u_owner', 'x-user-role': 'OWNER' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('accepts ADMIN role and returns aggregate shape', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/dashboard?period=today',
      headers: { 'x-user-id': 'u_admin', 'x-user-role': 'ADMIN' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('users');
    expect(body).toHaveProperty('properties');
    expect(body).toHaveProperty('bookings');
    expect(body).toHaveProperty('revenue');
    expect(body).toHaveProperty('visitors');
    expect(body).toHaveProperty('generatedAt');
    expect(body.period).toBe('today');
    await app.close();
  });

  it('rejects invalid period param with 400 (zod)', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/dashboard?period=forever',
      headers: { 'x-user-id': 'u_admin', 'x-user-role': 'SUPER_ADMIN' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error?: string };
    expect(body.error).toBe('VALIDATION');
    await app.close();
  });

  it('accepts FINANCE_ADMIN and SUPER_ADMIN roles', async () => {
    for (const role of ['FINANCE_ADMIN', 'SUPER_ADMIN']) {
      const app = await server();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/dashboard',
        headers: { 'x-user-id': 'u_' + role.toLowerCase(), 'x-user-role': role },
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    }
  });
});
