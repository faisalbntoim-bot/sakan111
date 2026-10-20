/**
 * Dev-only sandbox helper.
 *
 * The real payment path is: client → /v1/payments → sandbox createPayment
 * → user is redirected to the PSP's hosted checkout → PSP posts a
 * signed webhook to /v1/payments/webhook → capture.
 *
 * The sandbox PSP has no hosted checkout, so the UI tests cannot
 * complete the loop by driving a real browser. This route exposes a
 * single dev/test-only shortcut:
 *
 *   POST /v1/dev/sandbox/capture/:providerPaymentId
 *
 * It calls `simulateCapture(providerPaymentId)` to mark the sandbox
 * row captured in memory, HMAC-signs the resulting webhook payload
 * with the sandbox webhook secret, and POSTs it to the real
 * /v1/payments/webhook endpoint on this process. The webhook route
 * verifies the signature, runs idempotent capture, posts the ledger,
 * confirms the booking, and creates the invoice — exactly what a real
 * PSP would do.
 *
 * Security:
 *   - Mounted only when NODE_ENV ∈ {development, test}. In production
 *     the register call is skipped so the route does not exist, no 403
 *     to probe.
 *   - Caller must be authenticated. We do not expose this to
 *     anonymous traffic even in dev.
 *   - We do NOT mutate any Payment or Booking row here. We just
 *     construct the signed webhook payload and let the webhook route
 *     verify + process it, so the production code path runs end-to-end.
 */

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/rbac.js';
import { badRequest, notFound } from '../errors.js';
import { config } from '../config.js';
import { simulateCapture, simulateFailure, signWebhook } from '../providers/sandbox.js';

/** Read NODE_ENV from the live process environment, not from the
 *  cached `config` module, so a test can swap it per-register. The
 *  production bundle sets NODE_ENV=production at build time, so this
 *  evaluates identically to the config check in a real deployment. */
function devModeActive(): boolean {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

export default async function devSandboxRoutes(app: FastifyInstance) {
  if (!devModeActive()) {
    // Deliberately not registered in production.
    return;
  }

  app.post<{ Params: { providerPaymentId: string } }>(
    '/v1/dev/sandbox/capture/:providerPaymentId',
    async (req, reply) => {
      requireAuth(req, reply);
      const { providerPaymentId } = req.params;
      if (!providerPaymentId.startsWith('sb_pay_')) {
        throw badRequest('expected a sandbox providerPaymentId (sb_pay_…)');
      }

      let evt;
      try {
        evt = simulateCapture(providerPaymentId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('unknown payment')) throw notFound('sandbox payment not found');
        throw e;
      }

      const { body, signature } = signWebhook(evt);

      // Loop back through the real webhook endpoint. We hit the loopback
      // interface so the full verifyWebhook → capturePayment → ledger
      // path runs identically to a real PSP delivery.
      const url = `http://127.0.0.1:${config.PORT}/v1/payments/webhook`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sandbox-signature': signature,
          // Correlate dev calls in logs.
          'x-request-id': `dev-sandbox-${crypto.randomBytes(6).toString('hex')}`,
        },
        body,
      });
      const text = await res.text();
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { payload = text; }
      return reply.code(res.status).send({ ok: res.ok, webhook: payload });
    },
  );

  app.post<{ Params: { providerPaymentId: string } }>(
    '/v1/dev/sandbox/fail/:providerPaymentId',
    async (req, reply) => {
      requireAuth(req, reply);
      const { providerPaymentId } = req.params;
      if (!providerPaymentId.startsWith('sb_pay_')) {
        throw badRequest('expected a sandbox providerPaymentId (sb_pay_…)');
      }

      let evt;
      try {
        evt = simulateFailure(providerPaymentId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('unknown payment')) throw notFound('sandbox payment not found');
        throw e;
      }

      const { body, signature } = signWebhook(evt);
      const url = `http://127.0.0.1:${config.PORT}/v1/payments/webhook`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sandbox-signature': signature,
          'x-request-id': `dev-sandbox-${crypto.randomBytes(6).toString('hex')}`,
        },
        body,
      });
      const text = await res.text();
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { payload = text; }
      return reply.code(res.status).send({ ok: res.ok, webhook: payload });
    },
  );
}
