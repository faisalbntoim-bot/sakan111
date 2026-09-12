import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.string().default('info'),
  TZ: z.string().default('Asia/Riyadh'),
  DEFAULT_CURRENCY: z.string().length(3).default('SAR'),

  DATABASE_URL: z.string().min(1).default('file:./dev.db'),

  PAYMENT_PROVIDER: z.enum(['sandbox', 'moyasar', 'tap']).default('sandbox'),

  MOYASAR_SECRET_KEY: z.string().optional().default(''),
  MOYASAR_WEBHOOK_SECRET: z.string().optional().default(''),
  TAP_SECRET_KEY: z.string().optional().default(''),
  TAP_WEBHOOK_SECRET: z.string().optional().default(''),

  JWT_SECRET: z.string().min(8).default('dev-only-change-me'),
  JWT_ISSUER: z.string().default('sakanhub-backend'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  DEFAULT_PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(5),
  DEFAULT_TAX_RATE_PERCENT: z.coerce.number().min(0).max(100).default(15),

  MONEY_ROUNDING: z.enum(['banker', 'half-up', 'half-down']).default('banker'),

  // ---- Ops / Security ----
  /** Comma-separated list of allowed CORS origins. `*` allowed only outside production. */
  CORS_ALLOWED_ORIGINS: z.string().default('*'),
  /** JSON request bodies bigger than this in bytes are rejected. Webhook route overrides internally. */
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().positive().default(100 * 1024),
  /** Optional Sentry DSN. Empty = error tracker is a no-op. Never printed. */
  SENTRY_DSN: z.string().optional().default(''),

  // ---- Recommendation & Market Pulse feature flags (all OFF by default) ----
  /** Master switch for the /v1/analytics/events endpoint. Off = returns 503. */
  ANALYTICS_EVENTS_ENABLED: z.coerce.boolean().default(false),
  /** Ranks GET /v1/properties/feed?personalized=true by Recommendation Score. */
  RECOMMENDATION_ENGINE_ENABLED: z.coerce.boolean().default(false),
  /** Enables /v1/market/* routes (returns 503 when off). */
  MARKET_PULSE_ENABLED: z.coerce.boolean().default(false),
  /** Minimum event sample size for market pulse growth / trending to be reported. */
  MARKET_MIN_SAMPLE_SIZE: z.coerce.number().int().min(1).default(30),
  /** Smart-feed ranking (services/feed-ranking.ts). When true, GET
   *  /v1/properties/feed accepts ?sort=smart and ranks candidates by
   *  Quality × Match × Freshness. Default off — the existing feed
   *  behaviour is unchanged. */
  SMART_FEED_ENABLED: z.coerce.boolean().default(false),
  /** Internal event tracking (analytics/event-tracking-service.ts).
   *  When true, `trackEvent()` writes to `UserEvent` and
   *  POST /v1/events is live. Default off — no writes happen and the
   *  endpoint replies with 204 (safe no-op for the frontend). */
  EVENT_TRACKING_ENABLED: z.coerce.boolean().default(false),
  /** Recommendations v1 (recommendations/*). When true, GET
   *  /v1/recommendations and GET /v1/properties/:id/similar rank
   *  candidates using UserEvent history + Quality Score. Default off
   *  — endpoints still respond (safe fallback: fresh + high-quality
   *  listings) so the frontend can call blindly during rollout. */
  RECOMMENDATIONS_ENABLED: z.coerce.boolean().default(false),
});

export const config = schema.parse(process.env);
export type Config = typeof config;

/**
 * Refuse-to-boot checks. Runs at import time so a bad prod config never
 * silently starts serving traffic. Only fires when NODE_ENV === 'production'.
 */
function assertProdSafety(cfg: Config): void {
  if (cfg.NODE_ENV !== 'production') return;
  const problems: string[] = [];

  if (cfg.JWT_SECRET === 'dev-only-change-me' || cfg.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET must be a random string of at least 32 characters');
  }
  if (cfg.DATABASE_URL.startsWith('file:')) {
    problems.push('DATABASE_URL must NOT be a SQLite file in production (use postgresql://…)');
  }
  if (cfg.PAYMENT_PROVIDER === 'sandbox') {
    problems.push('PAYMENT_PROVIDER=sandbox is not allowed in production');
  }
  if (cfg.PAYMENT_PROVIDER === 'moyasar') {
    if (!cfg.MOYASAR_SECRET_KEY)     problems.push('MOYASAR_SECRET_KEY is required');
    if (!cfg.MOYASAR_WEBHOOK_SECRET) problems.push('MOYASAR_WEBHOOK_SECRET is required');
  }
  if (cfg.PAYMENT_PROVIDER === 'tap') {
    if (!cfg.TAP_SECRET_KEY)     problems.push('TAP_SECRET_KEY is required');
    if (!cfg.TAP_WEBHOOK_SECRET) problems.push('TAP_WEBHOOK_SECRET is required');
  }
  if (cfg.CORS_ALLOWED_ORIGINS.trim() === '*') {
    problems.push('CORS_ALLOWED_ORIGINS=* is not allowed in production; whitelist explicit origins');
  }

  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error('\n[config] production refuse-to-boot:\n  - ' + problems.join('\n  - ') + '\n');
    throw new Error('production configuration invalid; refusing to boot');
  }
}
assertProdSafety(config);
