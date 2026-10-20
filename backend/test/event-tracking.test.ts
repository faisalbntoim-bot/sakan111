/**
 * Event Tracking v1 — unit + route tests.
 *
 * Coverage:
 *   - unknown eventName rejected (no row written)
 *   - client cannot spoof userId (server-derived from auth context)
 *   - EVENT_TRACKING_ENABLED=false ⇒ safe no-op (endpoint still 204)
 *   - metadata > 4 KB drops the payload
 *   - oversized searchQuery is truncated (no crash)
 *   - sensitive/non-whitelisted metadata keys stripped
 *   - anonymous session event succeeds
 *   - authenticated event ignores body userId
 *   - property_view dedup within window
 *   - engagement summary aggregates correctly
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { buildTestApp, resetDb, shutdown } from './helpers.js';
import eventRoutes from '../src/routes/events.js';
import { trackEvent, sanitizeEventMetadata, _resetDedupCacheForTests } from '../src/analytics/event-tracking-service.js';
import { getPropertyEngagementSummary } from '../src/analytics/engagement-summary.js';
import { getPrisma } from '../src/db.js';
import { config } from '../src/config.js';

async function server() {
  return buildTestApp(async (a) => { await a.register(eventRoutes); });
}

beforeEach(async () => {
  await resetDb();
  // resetDb() targets financial/booking tables; the UserEvent table is
  // out-of-scope there so we truncate it locally to keep tests isolated.
  await getPrisma().userEvent.deleteMany();
  _resetDedupCacheForTests();
});
afterAll(async () => { await shutdown(); });

// ---- helpers -----------------------------------------------------

async function withFlag<T>(value: boolean, fn: () => Promise<T>): Promise<T> {
  const orig = config.EVENT_TRACKING_ENABLED;
  (config as unknown as { EVENT_TRACKING_ENABLED: boolean }).EVENT_TRACKING_ENABLED = value;
  try { return await fn(); } finally {
    (config as unknown as { EVENT_TRACKING_ENABLED: boolean }).EVENT_TRACKING_ENABLED = orig;
  }
}

// ---- metadata sanitisation --------------------------------------

describe('sanitizeEventMetadata', () => {
  it('drops non-whitelisted keys (password, token, headers)', () => {
    const out = sanitizeEventMetadata({
      source: 'feed', password: 'p@ss', token: 'jwt.abc', authorization: 'Bearer x',
    });
    expect(out.source).toBe('feed');
    expect(out).not.toHaveProperty('password');
    expect(out).not.toHaveProperty('token');
    expect(out).not.toHaveProperty('authorization');
  });

  it('truncates over-long searchQuery/query', () => {
    const long = 'x'.repeat(400);
    const out = sanitizeEventMetadata({ query: long });
    expect(typeof out.query).toBe('string');
    expect((out.query as string).length).toBe(200);
  });

  it('drops payloads larger than 4KB', () => {
    const big = { source: 'feed', filters: {} as Record<string, string> };
    for (let i = 0; i < 500; i++) big.filters['k' + i] = 'v'.repeat(50);
    const out = sanitizeEventMetadata(big);
    expect(out._oversized).toBe(true);
  });
});

// ---- trackEvent (service) ---------------------------------------

describe('trackEvent (service)', () => {
  it('is a no-op when EVENT_TRACKING_ENABLED is false', async () => {
    await withFlag(false, async () => {
      await trackEvent({ eventName: 'property_view', sessionId: 'anon-1', propertyId: 'p_1' });
      const count = await getPrisma().userEvent.count();
      expect(count).toBe(0);
    });
  });

  it('rejects unknown event names (no row written)', async () => {
    await withFlag(true, async () => {
      await trackEvent({ eventName: 'invented_event' as unknown as 'property_view', sessionId: 'anon-2', propertyId: 'p_2' });
      const count = await getPrisma().userEvent.count();
      expect(count).toBe(0);
    });
  });

  it('writes anonymous session events', async () => {
    await withFlag(true, async () => {
      await trackEvent({ eventName: 'property_share', sessionId: 'anon-3', propertyId: 'p_3', city: 'Riyadh' });
      const rows = await getPrisma().userEvent.findMany({ where: { anonymousSessionId: 'anon-3' } });
      expect(rows.length).toBe(1);
      expect(rows[0]?.eventType).toBe('property_share');
      expect(rows[0]?.userId).toBeNull();
    });
  });

  it('dedupes rapid property_view from the same session', async () => {
    await withFlag(true, async () => {
      await trackEvent({ eventName: 'property_view', sessionId: 'anon-4', propertyId: 'p_4' });
      await trackEvent({ eventName: 'property_view', sessionId: 'anon-4', propertyId: 'p_4' });
      await trackEvent({ eventName: 'property_view', sessionId: 'anon-4', propertyId: 'p_4' });
      const count = await getPrisma().userEvent.count({ where: { eventType: 'property_view', propertyId: 'p_4' } });
      expect(count).toBe(1);
    });
  });

  it('never throws even if insert fails (best-effort)', async () => {
    await withFlag(true, async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Provoke a failure by handing it a comically-long propertyId that
      // still won't crash the SQLite string column but simulates one:
      // instead we monkey-patch the prisma client for one call.
      const prisma = getPrisma();
      const orig = prisma.userEvent.create;
      (prisma.userEvent as unknown as { create: unknown }).create = async () => { throw new Error('simulated db down'); };
      try {
        await expect(trackEvent({ eventName: 'property_view', sessionId: 'anon-5', propertyId: 'p_5' })).resolves.toBeUndefined();
      } finally {
        (prisma.userEvent as unknown as { create: unknown }).create = orig;
        spy.mockRestore();
      }
    });
  });
});

// ---- POST /v1/events --------------------------------------------

describe('POST /v1/events', () => {
  it('returns 204 and a safe no-op when flag is off', async () => {
    await withFlag(false, async () => {
      const app = await server();
      const res = await app.inject({
        method: 'POST', url: '/v1/events',
        headers: { 'content-type': 'application/json' },
        payload: { eventName: 'property_view', sessionId: 'anon-x', propertyId: 'p_1' },
      });
      expect(res.statusCode).toBe(204);
      const count = await getPrisma().userEvent.count();
      expect(count).toBe(0);
      await app.close();
    });
  });

  it('accepts a valid anonymous event and writes it', async () => {
    await withFlag(true, async () => {
      const app = await server();
      const res = await app.inject({
        method: 'POST', url: '/v1/events',
        headers: { 'content-type': 'application/json' },
        payload: { eventName: 'property_open_gallery', sessionId: 'sess-anon-1', propertyId: 'p_g_1' },
      });
      expect(res.statusCode).toBe(204);
      const count = await getPrisma().userEvent.count({ where: { eventType: 'property_open_gallery' } });
      expect(count).toBe(1);
      await app.close();
    });
  });

  it('ignores client-supplied userId and uses auth context instead', async () => {
    await withFlag(true, async () => {
      const app = await server();
      const res = await app.inject({
        method: 'POST', url: '/v1/events',
        headers: { 'content-type': 'application/json', 'x-user-id': 'u_real', 'x-user-role': 'CUSTOMER' },
        payload: { eventName: 'property_save', propertyId: 'p_s_1', userId: 'u_spoofed' },
      });
      expect(res.statusCode).toBe(204);
      const rows = await getPrisma().userEvent.findMany({ where: { eventType: 'property_save' } });
      expect(rows.length).toBe(1);
      expect(rows[0]?.userId).toBe('u_real');
      expect(rows[0]?.anonymousSessionId).toBeNull();
      await app.close();
    });
  });

  it('returns 204 for unknown event names (silent drop)', async () => {
    await withFlag(true, async () => {
      const app = await server();
      const res = await app.inject({
        method: 'POST', url: '/v1/events',
        headers: { 'content-type': 'application/json' },
        payload: { eventName: 'made_up_event', sessionId: 'sess-anon-2', propertyId: 'p_x' },
      });
      expect(res.statusCode).toBe(204);
      const count = await getPrisma().userEvent.count();
      expect(count).toBe(0);
      await app.close();
    });
  });
});

// ---- engagement summary -----------------------------------------

describe('getPropertyEngagementSummary', () => {
  it('counts views + saves + gallery opens for a property', async () => {
    await withFlag(true, async () => {
      await trackEvent({ eventName: 'property_view',         sessionId: 'engA', propertyId: 'p_eng' });
      await trackEvent({ eventName: 'property_open_gallery', sessionId: 'engA', propertyId: 'p_eng' });
      await trackEvent({ eventName: 'property_open_gallery', sessionId: 'engB', propertyId: 'p_eng' });
      await trackEvent({ eventName: 'property_save',         sessionId: 'engB', propertyId: 'p_eng' });

      const summary = await getPropertyEngagementSummary('p_eng');
      expect(summary.views).toBe(1);
      expect(summary.saves).toBe(1);
      expect(summary.galleryOpens).toBe(2);
      expect(summary.reports).toBe(0);
    });
  });

  it('returns zeros for a property with no events', async () => {
    const s = await getPropertyEngagementSummary('nothing_here');
    expect(s.views).toBe(0);
    expect(s.saves).toBe(0);
    expect(s.contacts).toBe(0);
  });
});
