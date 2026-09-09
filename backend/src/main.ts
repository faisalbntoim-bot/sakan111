/**
 * SakanHub backend entrypoint.
 *
 * Layered defence:
 *   1. HTTPS is terminated by the reverse proxy in production; this process
 *      binds to HTTP on `PORT` — put nginx / Cloudflare in front.
 *   2. `@fastify/helmet` sets safe browser security headers.
 *   3. `@fastify/cors` origin list is `CORS_ALLOWED_ORIGINS` (env). Production
 *      refuses to boot if this is `*` (see `config.ts`).
 *   4. Global body size limit (`MAX_REQUEST_BODY_BYTES`, default 100KB).
 *   5. Global rate limit (200/min). Webhook route is exempted with `allowList`.
 *   6. `x-request-id` correlation header is generated per request and echoed
 *      in the response and in every log line.
 *   7. `x-user-id`/`x-user-role` header fallback is accepted ONLY when
 *      `NODE_ENV ∈ {development,test}` — see `auth/rbac.ts`.
 */

import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
import { ZodError } from 'zod';
import { config } from './config.js';
import { loggerOptions } from './logger.js';
import { AppError } from './errors.js';
import { errorTracker } from './observability/tracker.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import propertyRoutes from './routes/properties.js';
import bookingRoutes from './routes/bookings.js';
import paymentRoutes from './routes/payments.js';
import webhookRoutes from './routes/webhook.js';
import refundRoutes from './routes/refunds.js';
import walletRoutes from './routes/wallet.js';
import invoiceRoutes from './routes/invoices.js';
import adminRulesRoutes from './routes/admin.rules.js';
import adminReportRoutes from './routes/admin.reports.js';
import beneficiaryRoutes from './routes/beneficiaries.js';
import complaintRoutes from './routes/complaints.js';
import mediaRoutes from './routes/media.js';
import mediaProcessingRoutes from './routes/media.processing.js';
import tourRoutes from './routes/tours.js';
import adminPropertyRoutes from './routes/admin.properties.js';

export async function buildServer() {
  const app = Fastify({
    logger: loggerOptions,
    disableRequestLogging: config.NODE_ENV === 'test',
    bodyLimit: config.MAX_REQUEST_BODY_BYTES,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
  });

  // Echo the request id back so clients can correlate their logs with ours.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(helmet, {
    // Payment redirects + AR asset loads sometimes need frames; keep sensible defaults.
    contentSecurityPolicy: false, // API-only; no HTML served — CSP would break `/healthz` JSON tools
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  const allowed = config.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 1 && allowed[0] === '*') {
    await app.register(cors, { origin: true, credentials: true });
  } else {
    await app.register(cors, {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        cb(null, allowed.includes(origin));
      },
      credentials: true,
    });
  }

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    // Webhook path is exempt — PSP retry bursts should never 429.
    allowList: (req: FastifyRequest) => req.url.startsWith('/v1/payments/webhook'),
  });

  app.get('/healthz', async () => ({ ok: true, env: config.NODE_ENV }));

  // Webhook is registered as its own plugin scope so its rawBody parser stays local.
  await app.register(async (scope) => {
    await scope.register(webhookRoutes);
  });

  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(propertyRoutes);
  await app.register(bookingRoutes);
  await app.register(paymentRoutes);
  await app.register(refundRoutes);
  await app.register(walletRoutes);
  await app.register(invoiceRoutes);
  await app.register(adminRulesRoutes);
  await app.register(adminReportRoutes);
  await app.register(beneficiaryRoutes);
  await app.register(complaintRoutes);
  await app.register(mediaRoutes);
  await app.register(mediaProcessingRoutes);
  await app.register(tourRoutes);
  await app.register(adminPropertyRoutes);

  app.setErrorHandler((err, req, reply) => {
    // Duck-type on httpStatus so bundler / cross-module identity issues don't
    // downgrade a known AppError to 500.
    const e = err as { httpStatus?: number; code?: string; message?: string; details?: unknown; name?: string };
    if (typeof e.httpStatus === 'number' && (err instanceof AppError || e.code)) {
      return reply.code(e.httpStatus).send({ error: e.code, message: e.message, details: e.details, requestId: req.id });
    }
    if (err instanceof ZodError || e.name === 'ZodError') {
      return reply.code(400).send({ error: 'VALIDATION', issues: (err as ZodError).issues, requestId: req.id });
    }
    req.log.error({ err, reqId: req.id }, 'unhandled error');
    // Report to error tracker (no-op unless configured — never contains tokens).
    void errorTracker.captureException(err, { requestId: req.id, method: req.method, path: req.url });
    return reply.code(500).send({ error: 'INTERNAL', message: 'internal server error', requestId: req.id });
  });

  return app;
}

// Allow `node dist/main.js` to boot the server directly.
const isEntry = process.argv[1] && (process.argv[1].endsWith('main.js') || process.argv[1].endsWith('main.ts'));
if (isEntry) {
  buildServer()
    .then((app) => app.listen({ port: config.PORT, host: '0.0.0.0' }))
    .then((addr) => console.log(`sakanhub backend listening on ${addr}`))
    .catch((err) => { console.error(err); process.exit(1); });
}
