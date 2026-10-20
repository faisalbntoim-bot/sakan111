import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware — handles two orthogonal things:
 *
 *  1. `/` → `/ar` redirect.
 *     Done here (not in a Server Component) because Next.js SSG
 *     pre-renders a 404 shell + embeds the redirect digest in the
 *     RSC payload, and Vercel's static-serving layer surfaces the
 *     404 shell (not the redirect) for the raw HTML request. The
 *     middleware runs at the edge before any HTML is served — the
 *     visitor gets a clean 307 straight to the localised page.
 *
 *  2. Gate `/:locale/admin/*` on the presence of `sh_admin_session`.
 *     The cookie is HttpOnly + Secure (in prod) and is set only by
 *     the server-only route handler at /api/admin/login on a
 *     successful credential match. Middleware only checks that a
 *     cookie is present so this can stay Edge-compatible; full
 *     HMAC verification happens server-side in the route handler
 *     (defense in depth). Anyone without a cookie is redirected to
 *     /:locale/admin/login with a `?next=` return path.
 *
 * The default locale is inlined here rather than imported from
 * `@/lib/i18n` because that module transitively imports the ar/en
 * dictionary JSON files, which Vercel's Edge runtime rejects (edge
 * bundles cannot contain arbitrary Node module graphs). Keeping this
 * one string local makes the middleware bundle stand-alone.
 */
const DEFAULT_LOCALE = 'ar';
const ADMIN_COOKIE = 'sh_admin_session';

/** Match /:locale/admin and /:locale/admin/... but NOT /:locale/admin/login. */
function isAdminGateHit(pathname: string): boolean {
  const m = pathname.match(/^\/(ar|en)\/admin(?:\/(.*))?$/);
  if (!m) return false;
  const rest = m[2] ?? '';
  // /:locale/admin/login and any deeper /login/... is public (the sign-in surface).
  if (rest === 'login' || rest.startsWith('login/')) return false;
  return true;
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // 1. Root → default locale.
  if (pathname === '/') {
    return NextResponse.redirect(new URL(`/${DEFAULT_LOCALE}`, request.url), 307);
  }

  // 2. Admin gate.
  if (isAdminGateHit(pathname)) {
    const cookie = request.cookies.get(ADMIN_COOKIE)?.value;
    if (!cookie) {
      const locale = pathname.split('/')[1] || DEFAULT_LOCALE;
      const url = request.nextUrl.clone();
      url.pathname = `/${locale}/admin/login`;
      url.searchParams.set('next', pathname + (search || ''));
      return NextResponse.redirect(url, 307);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Root redirect + admin-gate matcher. The admin/login page itself
  // is intentionally NOT in the matcher — visitors need to reach it
  // when they DON'T have a cookie.
  matcher: ['/', '/ar/admin/:path*', '/en/admin/:path*'],
};
