/**
 * BFF for /v1/admin/dashboard — server-only proxy.
 *
 * Fixes the production issue where the browser was calling
 * /v1/admin/dashboard directly with no Authorization header. The
 * browser now hits THIS route on the same origin (deliberately under
 * /admin-api/ so Nginx `/api/` rewrite rules do not intercept it). We:
 *
 *   1. Verify the caller's Sakan admin cookie (`sh_admin_session`)
 *      via `verifySession()` — full HMAC + expiry check.
 *   2. Exchange the server-side service secret for a short-lived
 *      ADMIN JWT against the backend's /v1/auth/internal-admin-token
 *      endpoint (Phase 2). The JWT is cached in memory and refreshed
 *      2 minutes before it expires, so most dashboard hits pay only
 *      the cache lookup — no exchange round-trip.
 *   3. Forward to /v1/admin/dashboard with the fresh Bearer.
 *   4. Return the backend response verbatim (status + JSON body).
 *
 * Backend authorization is NEVER weakened. `/v1/admin/*` still
 * requires a real ADMIN JWT — the difference is that the JWT lives on
 * the Next.js server and travels only server-to-server, never in the
 * browser bundle.
 *
 * Env (all SERVER-ONLY, no NEXT_PUBLIC_ prefix):
 *   SAKAN_ADMIN_UPSTREAM_URL     — backend origin, e.g.
 *                                  https://api.sakanhubb.com. Falls back
 *                                  to NEXT_PUBLIC_API_BASE_URL (already
 *                                  public, so reading it server-side is
 *                                  not a leak).
 *   SAKAN_ADMIN_SERVICE_SECRET   — matches backend's
 *                                  SAKAN_INTERNAL_ADMIN_SECRET (≥32 chars).
 *                                  If unset, the BFF cannot exchange for
 *                                  a JWT and returns 503 with a clear
 *                                  configuration hint.
 *
 * Failure modes:
 *   - Missing cookie / bad signature  →  401
 *   - period param out of whitelist   →  400
 *   - env not configured              →  503 { error: 'admin_upstream_not_configured' }
 *   - token exchange failed           →  503 { error: 'admin_token_exchange_failed' }
 *   - upstream unreachable            →  502
 *   - upstream returned any status    →  pass-through verbatim
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE, verifySession } from '@/lib/server/admin-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_PERIODS = new Set(['today', '7d', '30d']);

/** Refresh the token when it has fewer than this many seconds left. */
const REFRESH_LEAD_SECONDS = 120;

type CachedToken = { accessToken: string; expiresAtMs: number };
type TokenGlobals = { __sakan_admin_bff_token__?: CachedToken; __sakan_admin_bff_inflight__?: Promise<CachedToken> };

function tokenSlot(): TokenGlobals {
  // Route modules can be evaluated multiple times in dev; store on
  // globalThis so the cache survives HMR reloads within one server proc.
  return globalThis as unknown as TokenGlobals;
}

function upstreamBase(): string | null {
  const explicit = process.env.SAKAN_ADMIN_UPSTREAM_URL;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit.replace(/\/+$/, '');
  const fallback = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (typeof fallback === 'string' && fallback.length > 0) return fallback.replace(/\/+$/, '');
  return null;
}

function serviceSecret(): string | null {
  const s = process.env.SAKAN_ADMIN_SERVICE_SECRET;
  return typeof s === 'string' && s.length >= 32 ? s : null;
}

async function fetchFreshToken(base: string, secret: string): Promise<CachedToken> {
  const res = await fetch(`${base}/v1/auth/internal-admin-token`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${secret}`, 'accept': 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    // Do not leak the presented secret or the upstream body verbatim.
    throw new Error(`token_exchange_status_${res.status}`);
  }
  const body = await res.json() as { accessToken?: unknown; expiresIn?: unknown };
  if (typeof body.accessToken !== 'string' || typeof body.expiresIn !== 'number') {
    throw new Error('token_exchange_shape');
  }
  return {
    accessToken: body.accessToken,
    expiresAtMs: Date.now() + body.expiresIn * 1000,
  };
}

/**
 * Return a valid cached token, refreshing it in the background once it
 * enters the last REFRESH_LEAD_SECONDS of its life. Concurrent callers
 * share the same in-flight promise so we never fire duplicate exchanges.
 */
async function getServiceToken(base: string, secret: string): Promise<CachedToken> {
  const slot = tokenSlot();
  const now = Date.now();
  const cached = slot.__sakan_admin_bff_token__;
  if (cached && cached.expiresAtMs - now > REFRESH_LEAD_SECONDS * 1000) return cached;
  if (slot.__sakan_admin_bff_inflight__) return slot.__sakan_admin_bff_inflight__;
  const p = fetchFreshToken(base, secret)
    .then((t) => { slot.__sakan_admin_bff_token__ = t; return t; })
    .finally(() => { slot.__sakan_admin_bff_inflight__ = undefined; });
  slot.__sakan_admin_bff_inflight__ = p;
  return p;
}

export async function GET(req: Request): Promise<NextResponse> {
  // 1. Frontend session check — no cookie, no data.
  const raw = cookies().get(ADMIN_COOKIE)?.value ?? null;
  const exp = verifySession(raw);
  if (exp === null) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2. Sanitise the query so we only forward the whitelisted period.
  const url = new URL(req.url);
  const period = url.searchParams.get('period') ?? 'today';
  if (!ALLOWED_PERIODS.has(period)) {
    return NextResponse.json({ error: 'invalid_period' }, { status: 400 });
  }

  const base = upstreamBase();
  const secret = serviceSecret();
  if (!base || !secret) {
    return NextResponse.json({
      error: 'admin_upstream_not_configured',
      hint: 'Set SAKAN_ADMIN_UPSTREAM_URL and SAKAN_ADMIN_SERVICE_SECRET (>=32 chars) on the Next.js server.',
    }, { status: 503 });
  }

  // 3. Server-to-server credential exchange (cached).
  let token: CachedToken;
  try {
    token = await getServiceToken(base, secret);
  } catch {
    // Wipe any half-baked cache so the next request tries fresh.
    (tokenSlot()).__sakan_admin_bff_token__ = undefined;
    return NextResponse.json({ error: 'admin_token_exchange_failed' }, { status: 503 });
  }

  // 4. Forward to /v1/admin/dashboard with the fresh Bearer.
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/admin/dashboard?period=${encodeURIComponent(period)}`, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${token.accessToken}`,
      },
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
  }

  // If the backend rejected our token (rotated user, secret drift), throw
  // the cache away so the next request re-mints.
  if (upstream.status === 401 || upstream.status === 403) {
    (tokenSlot()).__sakan_admin_bff_token__ = undefined;
  }

  // 5. Pass through the upstream response verbatim so status codes and
  // error shapes stay honest (401 stays 401, not silently mapped to 500).
  const text = await upstream.text();
  const headers = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  return new NextResponse(text, { status: upstream.status, headers });
}

/* Only GET is meaningful — other verbs stay silent to avoid advertising shape. */
export function POST()   { return new NextResponse('Not Found', { status: 404 }); }
export function PUT()    { return new NextResponse('Not Found', { status: 404 }); }
export function PATCH()  { return new NextResponse('Not Found', { status: 404 }); }
export function DELETE() { return new NextResponse('Not Found', { status: 404 }); }
