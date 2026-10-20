/**
 * Server-only helpers for the admin session cookie.
 *
 * Kept out of route files because Next.js Route Handlers reject
 * unknown named exports. This module imports `node:crypto`, so it
 * MUST NEVER be imported from a client component or from
 * middleware.ts (both run in the Edge runtime).
 *
 * Signing key: prefer an explicit SAKAN_ADMIN_SECRET (>=16 chars);
 * otherwise derive HMAC-SHA256("sakan-admin-session-v1", user:pass)
 * so a passphrase rotation invalidates every issued cookie.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE = 'sh_admin_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours

export type AdminCreds = { user: string; pass: string };

export function readAdminCreds(): AdminCreds | null {
  const user = process.env.SAKAN_ADMIN_USER;
  const pass = process.env.SAKAN_ADMIN_PASS;
  if (typeof user !== 'string' || user.length === 0) return null;
  if (typeof pass !== 'string' || pass.length === 0) return null;
  return { user, pass };
}

export function getSigningKey(creds: AdminCreds): Buffer {
  const explicit = process.env.SAKAN_ADMIN_SECRET;
  if (typeof explicit === 'string' && explicit.length >= 16) return Buffer.from(explicit);
  return createHmac('sha256', 'sakan-admin-session-v1')
    .update(creds.user + ':' + creds.pass)
    .digest();
}

/** Constant-time string equality (length-aware). */
export function safeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  const len = Math.max(ab.length, bb.length);
  const ap = Buffer.alloc(len); ab.copy(ap);
  const bp = Buffer.alloc(len); bb.copy(bp);
  const eq = timingSafeEqual(ap, bp);
  return eq && ab.length === bb.length;
}

/** Produce a `<expiresAt>.<hexSig>` cookie value. */
export function signSession(expiresAt: number, key: Buffer): string {
  const payload = String(expiresAt);
  const sig = createHmac('sha256', key).update('admin:' + payload).digest('hex');
  return payload + '.' + sig;
}

/**
 * Verify a session cookie. Returns the expiry (ms epoch) when valid
 * and unexpired; otherwise null. Callers should NOT treat a null as
 * "temporarily unavailable" — always redirect to login.
 */
export function verifySession(value: string | undefined | null): number | null {
  if (typeof value !== 'string' || value.length < 8) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const expStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  const creds = readAdminCreds();
  if (!creds) return null;
  const key = getSigningKey(creds);
  const expected = createHmac('sha256', key).update('admin:' + expStr).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length === 0 || a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? exp : null;
}
