/**
 * Recommendations v1 — SPA / Next.js helpers.
 *
 * Thin, fault-tolerant fetchers over the backend endpoints:
 *   GET /v1/recommendations?mode=&limit=&sessionId=&…
 *   GET /v1/properties/:id/similar?limit=&sessionId=
 *
 * Design constraints:
 *   - No third-party SDKs. Ever.
 *   - Never throws to the caller — a rejected promise or a non-2xx
 *     response resolves to `{ items: [] }` so the caller renders an
 *     empty section instead of a stack trace.
 *   - Reuses the same anonymous session id `analytics.ts` mints, so
 *     an anonymous visitor's saves / views can inform the panel
 *     without leaking any userId or fingerprint.
 *   - No-ops on the server (SSR) — components should render an empty
 *     shell and hydrate the recommendations on the client.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '';
const SESSION_KEY = 'sh_analytics_session';

function getSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}

export type RecommendationMode =
  | 'for_you'
  | 'similar'
  | 'recently_viewed_related'
  | 'saved_related'
  | 'new_for_you';

export type RecommendationItem = {
  id?: string;
  reasonAr?: string | null;
  // The backend may return either the full public projection or the
  // debug shape (`_score`, `_reasons`, `_reasonAr`) in non-production.
  [k: string]: unknown;
};

export type ForYouOptions = {
  mode?: RecommendationMode;
  limit?: number;
  city?: string;
  district?: string;
  propertyType?: string;
  listingType?: string;
  minPrice?: number;
  maxPrice?: number;
  signal?: AbortSignal;
};

export type ForYouResponse = {
  mode: RecommendationMode;
  personalized: boolean;
  fallback: boolean;
  items: RecommendationItem[];
};

async function safeGet(url: string, signal?: AbortSignal): Promise<unknown> {
  try {
    const res = await fetch(url, { method: 'GET', credentials: 'include', signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Fetch the "قد يعجبك" / For-You panel. Never rejects. */
export async function getForYouRecommendations(opts: ForYouOptions = {}): Promise<ForYouResponse> {
  const empty: ForYouResponse = { mode: opts.mode ?? 'for_you', personalized: false, fallback: true, items: [] };
  if (typeof window === 'undefined' || !API_BASE) return empty;

  const qs = new URLSearchParams();
  if (opts.mode) qs.set('mode', opts.mode);
  if (opts.limit) qs.set('limit', String(Math.max(1, Math.min(50, opts.limit))));
  const sid = getSessionId();
  if (sid) qs.set('sessionId', sid);
  if (opts.city) qs.set('city', opts.city);
  if (opts.district) qs.set('district', opts.district);
  if (opts.propertyType) qs.set('propertyType', opts.propertyType);
  if (opts.listingType) qs.set('listingType', opts.listingType);
  if (typeof opts.minPrice === 'number') qs.set('minPrice', String(opts.minPrice));
  if (typeof opts.maxPrice === 'number') qs.set('maxPrice', String(opts.maxPrice));

  const body = await safeGet(`${API_BASE}/v1/recommendations?${qs.toString()}`, opts.signal);
  if (!body || typeof body !== 'object') return empty;
  const b = body as Partial<ForYouResponse>;
  return {
    mode: (b.mode as RecommendationMode) ?? empty.mode,
    personalized: Boolean(b.personalized),
    fallback: Boolean(b.fallback),
    items: Array.isArray(b.items) ? b.items as RecommendationItem[] : [],
  };
}

/** Fetch "عقارات مشابهة" for a given property. Never rejects. */
export async function getSimilarProperties(propertyId: string, limit = 8, signal?: AbortSignal): Promise<RecommendationItem[]> {
  if (typeof window === 'undefined' || !API_BASE || !propertyId) return [];
  const qs = new URLSearchParams({ limit: String(Math.max(1, Math.min(50, limit))) });
  const sid = getSessionId();
  if (sid) qs.set('sessionId', sid);
  const body = await safeGet(`${API_BASE}/v1/properties/${encodeURIComponent(propertyId)}/similar?${qs.toString()}`, signal);
  if (!body || typeof body !== 'object') return [];
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items) ? (items as RecommendationItem[]) : [];
}
