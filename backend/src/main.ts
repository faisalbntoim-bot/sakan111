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
import adminPropertyRoutes from './routes/admin.properties.js';
import analyticsRoutes from './routes/analytics.js';
import marketRoutes from './routes/market.js';
import adminOverviewRoutes from './routes/admin.overview.js';
import eventRoutes from './routes/events.js';
import recommendationRoutes from './routes/recommendations.js';
import devSandboxRoutes from './routes/dev.sandbox.js';
import { runBookingExpirySweep } from './workers/booking-expiry.js';

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

  // Register the error handler BEFORE routes so AppError (badRequest/notFound/
  // conflict/…) maps to the correct HTTP status. Set after registrations,
  // Fastify's encapsulation keeps the default handler for already-registered
  // plugins and a thrown `conflict()` surfaces as 500 instead of 409.
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
    void errorTracker.captureException(err, { requestId: req.id, method: req.method, path: req.url });
    return reply.code(500).send({ error: 'INTERNAL', message: 'internal server error', requestId: req.id });
  });

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
  await app.register(adminPropertyRoutes);
  await app.register(analyticsRoutes);
  await app.register(marketRoutes);
  await app.register(adminOverviewRoutes);
  await app.register(eventRoutes);
  await app.register(recommendationRoutes);
  await app.register(devSandboxRoutes);

  // Automatic booking-expiry sweeper. Keeps calendars honest without
  // depending on an external cron: a stale draft or pending_payment
  // row is cancelled on the next tick, not when a test harness
  // explicitly calls the worker. The interval is configurable
  // (BOOKING_EXPIRY_SWEEP_INTERVAL_MS); setting it to 0 lets an
  // operator opt out and run the worker from cron instead.
  //
  // Guarantees against races:
  //   * runBookingExpirySweep's updateMany uses the row's current
  //     status as a predicate, so a sibling capture flipping the row
  //     to confirmed between the sweep's read and update is a 0-row
  //     claim — safe no-op.
  //   * A capturePayment arriving AFTER the sweep cancels the row
  //     takes the orphan path (see payment.orchestrator).
  if (config.BOOKING_EXPIRY_SWEEP_INTERVAL_MS > 0) {
    const sweeperInterval = config.BOOKING_EXPIRY_SWEEP_INTERVAL_MS;
    let running = false;
    const tick = async () => {
      if (running) return;      // overlap guard — a slow sweep won't stack
      running = true;
      try {
        await runBookingExpirySweep({
          draftTtlMinutes:   config.BOOKING_DRAFT_TTL_MINUTES,
          pendingTtlMinutes: config.BOOKING_PENDING_TTL_MINUTES,
        });
      } catch (err) {
        app.log.error({ err }, 'booking-expiry sweep failed');
      } finally {
        running = false;
      }
    };
    const handle = setInterval(() => { void tick(); }, sweeperInterval);
    // Don't keep the Node loop alive just for the sweeper (tests
    // depend on the server closing cleanly).
    if (typeof handle.unref === 'function') handle.unref();
    app.addHook('onClose', async () => { clearInterval(handle); });
    // Visibility — tests + log scrapes read this through app.decorate.
    app.decorate('sakanSweeperIntervalMs', sweeperInterval);
  }

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
