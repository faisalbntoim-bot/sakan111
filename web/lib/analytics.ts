/**
 * Fire-and-forget event tracker for the SPA + Next.js pages.
 *
 * Design constraints:
 *   - No third-party analytics SDK. Ever.
 *   - Never blocks navigation or throws to the caller.
 *   - Reuses an anonymous sessionStorage token; no fingerprinting.
 *   - No-ops on the server (typeof window === 'undefined').
 *   - No-ops silently if NEXT_PUBLIC_API_BASE_URL is unset or the
 *     backend replies non-2xx — the backend endpoint is itself a
 *     safe no-op when EVENT_TRACKING_ENABLED is false, so calling
 *     early is harmless.
 *
 * Events supported: see backend/src/analytics/event-types.ts.
 */

type EventName =
  | 'property_view'
  | 'property_save'
  | 'property_unsave'
  | 'property_share'
  | 'property_contact'
  | 'property_call'
  | 'property_whatsapp'
  | 'property_open_gallery'
  | 'property_open_map'
  | 'property_open_tour'
  | 'property_hide'
  | 'property_report'
  | 'search'
  | 'filter_change'
  | 'feed_impression'
  | 'feed_click';

type TrackData = {
  propertyId?: string;
  city?: string;
  district?: string;
  propertyType?: string;
  listingType?: string;
  searchQuery?: string;
  metadata?: Record<string, string | number | boolean>;
};

const SESSION_KEY = 'sh_analytics_session';
const VIEW_DEDUP_KEY = 'sh_view_seen';

/** Get (or lazily mint) an opaque anonymous session token. */
function getSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    let s = window.sessionStorage.getItem(SESSION_KEY);
    if (!s) {
      // 24 chars of URL-safe randomness — enough to distinguish tabs
      // without being fingerprint-strong.
      const rnd = new Uint8Array(18);
      (window.crypto || (window as unknown as { msCrypto: Crypto }).msCrypto).getRandomValues(rnd);
      s = Array.from(rnd).map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
      window.sessionStorage.setItem(SESSION_KEY, s);
    }
    return s;
  } catch { return null; }
}

/** Track a client-side dedup guard so we don't fire property_view twice per session per property. */
function seenPropertyView(propertyId: string): boolean {
  if (typeof window === 'undefined') return true; // treat SSR as "already seen"
  try {
    const raw = window.sessionStorage.getItem(VIEW_DEDUP_KEY);
    const set = new Set<string>(raw ? JSON.parse(raw) : []);
    if (set.has(propertyId)) return true;
    set.add(propertyId);
    // Keep the set bounded — retain only the last 200 property ids per tab.
    const arr = [...set];
    const bounded = arr.length > 200 ? arr.slice(arr.length - 200) : arr;
    window.sessionStorage.setItem(VIEW_DEDUP_KEY, JSON.stringify(bounded));
    return false;
  } catch { return true; }
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '';

/**
 * Send an event to the backend. Fire-and-forget: returns a Promise
 * that always resolves, never throws. Callers should NOT await it in
 * a critical UI path — it's designed to be safely ignored.
 */
export function trackEvent(eventName: EventName, data: TrackData = {}): void {
  try {
    if (typeof window === 'undefined') return;
    if (!API_BASE) return; // no backend wired for this environment
    if (eventName === 'property_view' && data.propertyId && seenPropertyView(data.propertyId)) return;

    const sessionId = getSessionId();
    const payload = JSON.stringify({ eventName, sessionId, ...data });

    // Prefer sendBeacon — it survives page unload and never blocks.
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(`${API_BASE}/v1/events`, blob);
      return;
    }
    // Fallback: fetch, no-cors, keepalive so the request survives navigation.
    void fetch(`${API_BASE}/v1/events`, {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      credentials: 'include',
    }).catch(() => { /* silent */ });
  } catch {
    // Analytics can never break the app.
  }
}
