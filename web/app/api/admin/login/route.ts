/**
 * Admin login — server-side credential gate for the /:locale/admin UI.
 *
 * Security posture:
 *   - Runs SERVER-SIDE only (Next.js Route Handler, Node runtime).
 *     Nothing from this file is inlined into the client bundle.
 *   - Credentials come from server-only env vars: SAKAN_ADMIN_USER
 *     and SAKAN_ADMIN_PASS. These MUST NOT be prefixed with
 *     `NEXT_PUBLIC_`. If either is unset the endpoint 404s as if
 *     it did not exist, so an operator has to explicitly configure
 *     the login on each environment.
 *   - Compares user + pass with `timingSafeEqual` (constant-time)
 *     against buffers padded to the same length. Failed logins do
 *     not disclose which of the two fields was wrong.
 *   - On success sets `sh_admin_session` as an HttpOnly, SameSite=Lax,
 *     Secure (in prod) cookie signed with HMAC-SHA256. The cookie
 *     value carries only `expiresAt.signature` — no username, no
 *     password, no PII. Session TTL is 8 hours.
 *
 * The cookie only gates the FRONTEND /admin shell (see middleware.ts).
 * Backend authorization on /v1/admin/* endpoints continues to require
 * a Bearer JWT with the ADMIN role — this route does not mint one.
 */

import { NextResponse } from 'next/server';
import {
  ADMIN_COOKIE, SESSION_TTL_SECONDS,
  getSigningKey, readAdminCreds, safeEqualStrings, signSession,
} from '../../../../lib/server/admin-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  const creds = readAdminCreds();
  if (!creds) {
    // Feature not configured on this environment → treat as absent.
    return new NextResponse('Not Found', { status: 404 });
  }
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const parsed = (typeof body === 'object' && body !== null)
    ? body as { user?: unknown; pass?: unknown }
    : {};
  const user = typeof parsed.user === 'string' ? parsed.user : '';
  const pass = typeof parsed.pass === 'string' ? parsed.pass : '';
  const ok = safeEqualStrings(user, creds.user) && safeEqualStrings(pass, creds.pass);
  if (!ok) {
    // Generic 401 — never disclose which field was wrong.
    return NextResponse.json({ ok: false, error: 'invalid_credentials' }, { status: 401 });
  }
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const value = signSession(expiresAt, getSigningKey(creds));
  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.cookies.set(ADMIN_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}

/** Clear the session cookie. Idempotent. */
export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true }, { status: 200 });
  res.cookies.set(ADMIN_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return res;
}

/* Other verbs: 404 so the server never advertises what this endpoint accepts. */
export function GET() { return new NextResponse('Not Found', { status: 404 }); }
export function PUT() { return new NextResponse('Not Found', { status: 404 }); }
export function PATCH() { return new NextResponse('Not Found', { status: 404 }); }
