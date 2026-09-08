import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge redirect for `/` → `/ar`.
 *
 * We deliberately handle this in middleware instead of a Server Component's
 * `redirect()` call because Next.js SSG pre-renders a 404 shell + embeds
 * the redirect digest in the RSC payload, and Vercel's static-serving
 * layer surfaces the 404 shell (not the redirect) for the raw HTML request.
 * The middleware runs at the edge before any HTML is served — the visitor
 * gets a clean 307 straight to the localised page.
 *
 * The default locale is inlined here rather than imported from
 * `@/lib/i18n` because that module transitively imports the ar/en
 * dictionary JSON files, which Vercel's Edge runtime rejects (edge
 * bundles cannot contain arbitrary Node module graphs). Keeping this
 * one string local makes the middleware bundle stand-alone.
 *
 * Matcher is scoped to the root path only; every other route is untouched.
 */
const DEFAULT_LOCALE = 'ar';

export function middleware(request: NextRequest) {
  return NextResponse.redirect(new URL(`/${DEFAULT_LOCALE}`, request.url), 307);
}

export const config = {
  matcher: ['/'],
};
