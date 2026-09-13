/**
 * Preview-only admin login shortcut.
 *
 * Security posture:
 *   - Runs SERVER-SIDE only (Next.js Route Handler, nodejs runtime).
 *     Nothing from this file is inlined into the client bundle.
 *   - Credentials come from server-only env vars: SAKAN_DEV_ADMIN_USER
 *     and SAKAN_DEV_ADMIN_PASS. NEVER prefix these with `NEXT_PUBLIC_`.
 *     If either is missing, the endpoint returns 404 as if it did not
 *     exist.
 *   - In production (`NODE_ENV === 'production'`) the endpoint short-
 *     circuits to 404 unconditionally. Even if someone sets the env
 *     vars in a production environment by mistake, this handler still
 *     refuses to authenticate.
 *   - Constant-time comparison on both fields so timing attacks cannot
 *     leak character-by-character info about the placeholder pair.
 *   - The handler never returns a token, never sets a cookie, and never
 *     grants admin access on the backend. It only signals to the client
 *     that the preview shortcut may proceed — the actual admin surface
 *     is still protected by the real Bearer/JWT auth at the API layer.
 */

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function readCreds(): { user: string; pass: string } | null {
  const user = process.env.SAKAN_DEV_ADMIN_USER;
  const pass = process.env.SAKAN_DEV_ADMIN_PASS;
  if (typeof user !== 'string' || user.length === 0) return null;
  if (typeof pass !== 'string' || pass.length === 0) return null;
  return { user, pass };
}

function safeEqual(a: string, b: string): boolean {
  // Same-length buffers only; pad the shorter to the longer and OR the
  // length-mismatch into the final decision so both branches take the
  // same amount of work.
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len); aBuf.copy(aPad);
  const bPad = Buffer.alloc(len); bBuf.copy(bPad);
  const eq = timingSafeEqual(aPad, bPad);
  return eq && aBuf.length === bBuf.length;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (isProduction()) {
    // Production must never accept this route. Return 404 so it is
    // indistinguishable from a non-existent endpoint.
    return new NextResponse('Not Found', { status: 404 });
  }
  const creds = readCreds();
  if (!creds) {
    // Feature not configured in this environment → treat as absent.
    return new NextResponse('Not Found', { status: 404 });
  }
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const parsed = (typeof body === 'object' && body !== null) ? body as { user?: unknown; pass?: unknown } : {};
  const user = typeof parsed.user === 'string' ? parsed.user : '';
  const pass = typeof parsed.pass === 'string' ? parsed.pass : '';
  const ok = safeEqual(user, creds.user) && safeEqual(pass, creds.pass);
  if (!ok) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}

// Any non-POST method: match the "does not exist in production" story
// by returning 404 across the board (server never advertises what verbs
// this preview endpoint accepts).
export function GET() { return new NextResponse('Not Found', { status: 404 }); }
export function PUT() { return new NextResponse('Not Found', { status: 404 }); }
export function DELETE() { return new NextResponse('Not Found', { status: 404 }); }
export function PATCH() { return new NextResponse('Not Found', { status: 404 }); }
