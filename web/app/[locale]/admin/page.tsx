/**
 * Admin dashboard — server-side session gate.
 *
 * This is a Server Component that runs BEFORE any dashboard markup is
 * sent to the browser. It reads the `sh_admin_session` cookie and runs
 * the full HMAC-SHA256 verification via `verifySession()` (server-only
 * `node:crypto`). Middleware.ts is the first layer (Edge, presence-only
 * check); this file is the second layer — signatures, expiry, and
 * env-key derivation are checked here, so a forged / stale / truncated
 * cookie can never render the dashboard even if middleware were bypassed.
 *
 * On failure we `redirect()` to `/:locale/admin/login?next=…` — no
 * markup is streamed and the client never sees a "logged-out flash".
 *
 * The actual dashboard UI is still a client component; we simply mount
 * it below the gate.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_COOKIE, verifySession } from '@/lib/server/admin-session';
import AdminDashboardClient from './dashboard-client';

export const dynamic = 'force-dynamic';

export default async function AdminDashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  // Next 15: `cookies()` and route `params` are async. Awaiting both so
  // this page compiles under the new runtime without changing behaviour.
  const { locale } = await params;
  const raw = (await cookies()).get(ADMIN_COOKIE)?.value ?? null;
  const exp = verifySession(raw);
  if (exp === null) {
    // Any failure mode — missing, malformed, wrong signature, expired,
    // or env credentials rotated / unset — funnels to the same redirect.
    // Preserve where the user wanted to land.
    redirect(`/${locale}/admin/login?next=${encodeURIComponent(`/${locale}/admin`)}`);
  }
  return <AdminDashboardClient params={{ locale }} />;
}
