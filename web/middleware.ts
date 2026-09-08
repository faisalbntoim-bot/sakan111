import { NextResponse, type NextRequest } from 'next/server';
import { defaultLocale } from '@/lib/i18n';

/**
 * Edge redirect for `/` → `/${defaultLocale}`.
 *
 * We deliberately handle this in middleware instead of a Server Component's
 * `redirect()` call because Next.js SSG pre-renders a 404 shell + embeds
 * the redirect digest in the RSC payload, and Vercel's static-serving
 * layer surfaces the 404 shell (not the redirect) for the raw HTML request.
 * The middleware runs at the edge before any HTML is served — the visitor
 * gets a clean 307 straight to the localised page.
 *
 * Matcher is scoped to the root path only; every other route is untouched.
 */
export function middleware(request: NextRequest) {
  return NextResponse.redirect(new URL(`/${defaultLocale}`, request.url), 307);
}

export const config = {
  matcher: ['/'],
};
