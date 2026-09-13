/**
 * Property Authoring v1 — typed API client.
 *
 * Auth: the token is minted by the OTP → JWT flow on the owner login
 * page (`/[locale]/owner/login`), which calls the existing backend
 * /v1/auth/otp + /v1/auth/otp/verify endpoints and stores the
 * resulting `accessToken` in sessionStorage under `sh_owner_token`.
 *
 * This module never exposes the token in the UI. It is:
 *   - read from sessionStorage
 *   - sent as `Authorization: Bearer <token>` on every request
 *   - cleared (`setOwnerToken(null)`) on 401/403 so the page can
 *     redirect to the login route
 *
 * All calls are best-effort and Arabic-friendly on failure — the
 * caller must never see a raw stack trace.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '';
const TOKEN_KEY = 'sh_owner_token';

// ---------- Types (mirror backend Property + v2 fields) ----------

export type PropertyStatus = 'available' | 'reserved' | 'sold' | 'rented' | 'hidden';
export type PricePeriod = 'TOTAL' | 'YEAR' | 'MONTH' | 'WEEK' | 'DAY';

export type PropertyRow = {
  id: string;
  listingNumber: string;
  ownerId: string;
  category: string;                  // == propertyType
  purpose: string;                   // == listingType
  status: PropertyStatus;
  currency: string;
  createdAt: string;
  updatedAt: string;
  advertisementLifecycle: string;
  // v2 optional fields
  city?: string | null;
  district?: string | null;
  addressText?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  priceHalalahs?: string | number | null;   // JSON encodes BigInt as string
  pricePeriod?: PricePeriod | null;
  areaSqm?: number | null;
  landAreaSqm?: number | null;
  builtAreaSqm?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  livingRooms?: number | null;
  kitchens?: number | null;
  floorNumber?: number | null;
  totalFloors?: number | null;
  propertyAgeYears?: number | null;
  yearBuilt?: number | null;
  furnished?: boolean | null;
  parkingSpaces?: number | null;
  hasElevator?: boolean | null;
  hasPool?: boolean | null;
  hasBalcony?: boolean | null;
  hasYard?: boolean | null;
  hasMaidRoom?: boolean | null;
  hasDriverRoom?: boolean | null;
  hasAirConditioning?: boolean | null;
  publishedAt?: string | null;
  expiresAt?: string | null;
};

export type PropertyDetailsPatch = Partial<Omit<PropertyRow,
  'id' | 'listingNumber' | 'ownerId' | 'status' | 'currency' | 'createdAt' | 'updatedAt' | 'advertisementLifecycle' | 'category' | 'purpose'
>>;

export class AuthoringApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ---------- Session helpers ----------

export function getOwnerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setOwnerToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token && token.trim().length > 0) window.sessionStorage.setItem(TOKEN_KEY, token.trim());
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode — silent */ }
}

// ---------- Internal ----------

function assertConfigured(): void {
  if (!API_BASE) {
    throw new AuthoringApiError('NO_API_BASE', 'API غير مُهيَّأ (NEXT_PUBLIC_API_BASE_URL مفقود).', 0);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  assertConfigured();
  const token = getOwnerToken();
  if (!token) throw new AuthoringApiError('NO_AUTH', 'الرجاء تسجيل الدخول أولاً.', 401);
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
  } catch {
    throw new AuthoringApiError('NETWORK', 'تعذّر الوصول إلى الخادم. تحقّق من الاتصال بالإنترنت.', 0);
  }
  if (res.status === 401 || res.status === 403) {
    // Clear the dead token so the next page render redirects to login
    // instead of re-firing a doomed request.
    setOwnerToken(null);
    throw new AuthoringApiError('AUTH_EXPIRED', 'انتهت الجلسة. الرجاء تسجيل الدخول من جديد.', res.status);
  }
  if (res.status === 404) {
    throw new AuthoringApiError('NOT_FOUND', 'العقار غير موجود أو لا تملك صلاحية تعديله.', 404);
  }
  if (res.status === 400) {
    let msg = 'تحقّق من الحقول المدخلة.';
    try {
      const body = await res.json() as { message?: string };
      if (body?.message) msg = body.message;
    } catch { /* ignore */ }
    throw new AuthoringApiError('VALIDATION', msg, 400);
  }
  if (!res.ok) {
    throw new AuthoringApiError('SERVER', 'حدث خطأ غير متوقع. حاول مجددًا.', res.status);
  }
  if (res.status === 204) return undefined as unknown as T;
  return await res.json() as T;
}

// ---------- Public API ----------

export type OwnerMe = {
  id: string;
  phone: string;
  email: string | null;
  nameAr: string;
  nameEn: string | null;
  roles: string[];
  currentRole: string;
};

/**
 * Probe the current session. Resolves to the caller identity on 200
 * or throws AuthoringApiError with code 'AUTH_EXPIRED' on 401/403.
 * Callers use this to decide whether to render the page or redirect
 * to /[locale]/owner/login.
 */
export function fetchOwnerMe(): Promise<OwnerMe> {
  return req<OwnerMe>(`/v1/auth/me`, { method: 'GET' });
}

/** Mint an owner session by exchanging OTP request+code for an access token. */
export async function requestOwnerOtp(phone: string): Promise<{ requestId: string; expiresInSeconds: number }> {
  assertConfigured();
  const res = await fetch(`${API_BASE}/v1/auth/otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  }).catch(() => null);
  if (!res) throw new AuthoringApiError('NETWORK', 'تعذّر الوصول إلى الخادم.', 0);
  if (res.status === 429) throw new AuthoringApiError('RATE_LIMIT', 'محاولات كثيرة. حاول بعد قليل.', 429);
  if (!res.ok) throw new AuthoringApiError('SERVER', 'تعذّر طلب رمز التحقق. تأكد من رقم الجوال.', res.status);
  return await res.json() as { requestId: string; expiresInSeconds: number };
}

export async function verifyOwnerOtp(input: { requestId: string; phone: string; code: string; nameAr?: string }): Promise<{
  user: { id: string; phone: string; nameAr: string; role: string };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  assertConfigured();
  const res = await fetch(`${API_BASE}/v1/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).catch(() => null);
  if (!res) throw new AuthoringApiError('NETWORK', 'تعذّر الوصول إلى الخادم.', 0);
  if (res.status === 401) throw new AuthoringApiError('VALIDATION', 'الرمز غير صحيح أو انتهت صلاحيته.', 401);
  if (!res.ok) throw new AuthoringApiError('SERVER', 'تعذّر التحقق من الرمز.', res.status);
  const body = await res.json() as { user: { id: string; phone: string; nameAr: string; role: string }; accessToken: string; refreshToken: string; expiresIn: number };
  // Persist the token so subsequent authoring calls attach it via getOwnerToken().
  setOwnerToken(body.accessToken);
  return body;
}

/** Clear the local session token. Server refresh-token revocation is a follow-up. */
export function clearOwnerSession(): void {
  setOwnerToken(null);
}

export function listMyProperties(): Promise<{ items: PropertyRow[] }> {
  return req<{ items: PropertyRow[] }>(`/v1/properties/mine`, { method: 'GET' });
}

export function getMyProperty(id: string): Promise<PropertyRow> {
  return req<PropertyRow>(`/v1/properties/${encodeURIComponent(id)}`, { method: 'GET' });
}

export function createPropertyDraft(input: { category: string; purpose: string; currency?: string }): Promise<PropertyRow> {
  return req<PropertyRow>(`/v1/properties/mine`, {
    method: 'POST',
    body: JSON.stringify({ category: input.category, purpose: input.purpose, currency: input.currency ?? 'SAR' }),
  });
}

export function updatePropertyDetails(id: string, patch: PropertyDetailsPatch): Promise<PropertyRow> {
  // Strip undefined so { furnished: undefined } doesn't reach zod.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
  return req<PropertyRow>(`/v1/properties/${encodeURIComponent(id)}/details`, {
    method: 'PATCH',
    body: JSON.stringify(clean),
  });
}

/**
 * Owner-side submit (moves lifecycle DRAFT → SUBMITTED).
 * Publishing still requires an admin to verify + publish.
 */
export function submitPropertyForReview(id: string): Promise<PropertyRow> {
  return req<PropertyRow>(`/v1/properties/${encodeURIComponent(id)}/submit`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
