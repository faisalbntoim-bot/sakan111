/**
 * Booking API client (customer side).
 *
 * Mints a session via the same OTP endpoints used for owners / admins
 * (/v1/auth/otp + /v1/auth/otp/verify), but stores the access token in
 * sessionStorage under `sh_customer_token` so it does not collide with
 * the owner/admin sessions and clears on tab close.
 *
 * Nothing here commits to the server for real money: the create /
 * capture pair runs against whatever provider the backend selects
 * (`sandbox` on dev; `moyasar`/`tap` later). On sandbox there is no
 * hosted checkout, so `captureSandboxPayment()` loops back through the
 * dev-only route /v1/dev/sandbox/capture/:providerPaymentId which
 * signs a webhook and POSTs it to /v1/payments/webhook — the full
 * production code path runs end-to-end.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '';
const CUSTOMER_TOKEN_KEY = 'sh_customer_token';
const CUSTOMER_PHONE_KEY = 'sh_customer_phone';

export class BookingApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;
  constructor(code: string, message: string, httpStatus: number, details?: unknown) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function getCustomerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage.getItem(CUSTOMER_TOKEN_KEY); } catch { return null; }
}

export function setCustomerToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token == null) window.sessionStorage.removeItem(CUSTOMER_TOKEN_KEY);
    else window.sessionStorage.setItem(CUSTOMER_TOKEN_KEY, token);
  } catch { /* storage disabled; the UI will prompt for login next time */ }
}

export function getCustomerPhone(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage.getItem(CUSTOMER_PHONE_KEY); } catch { return null; }
}

export function setCustomerPhone(phone: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (phone == null) window.sessionStorage.removeItem(CUSTOMER_PHONE_KEY);
    else window.sessionStorage.setItem(CUSTOMER_PHONE_KEY, phone);
  } catch { /* ignore */ }
}

async function parseError(res: Response): Promise<BookingApiError> {
  let body: { error?: string; message?: string; details?: unknown } = {};
  try { body = await res.json() as typeof body; } catch { /* non-JSON — use status */ }
  const code = body.error || 'HTTP_' + res.status;
  const message = body.message || `HTTP ${res.status}`;
  return new BookingApiError(code, message, res.status, body.details);
}

export interface BackendProperty {
  id: string;
  listingNumber: string;
  category: string;
  purpose: string;
  status: string;
  city: string | null;
  district: string | null;
  priceHalalahs: string | null;
  pricePeriod: string | null;
  areaSqm: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  furnished: boolean | null;
  currency: string;
  advertisementLifecycle: string;
}

export async function fetchBackendProperty(id: string): Promise<BackendProperty> {
  const res = await fetch(`${API_BASE}/v1/properties/${encodeURIComponent(id)}`);
  if (!res.ok) throw await parseError(res);
  return await res.json() as BackendProperty;
}

export async function requestCustomerOtp(phone: string): Promise<{ requestId: string }> {
  const res = await fetch(`${API_BASE}/v1/auth/otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  if (!res.ok) throw await parseError(res);
  return await res.json() as { requestId: string };
}

export async function verifyCustomerOtp(input: {
  requestId: string;
  phone: string;
  code: string;
  nameAr?: string;
}): Promise<{ accessToken: string; refreshToken: string; user: { id: string; phone: string; role: string } }> {
  const res = await fetch(`${API_BASE}/v1/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
  const body = await res.json() as { accessToken: string; refreshToken: string; user: { id: string; phone: string; role: string } };
  setCustomerToken(body.accessToken);
  setCustomerPhone(body.user.phone);
  return body;
}

export interface CreateBookingInput {
  propertyId: string;
  transactionType: 'DAILY_RENTAL' | 'LONG_TERM_RENTAL' | 'COMMERCIAL_RENTAL' | 'SALE';
  grossAmount: string | number;
  currency?: string;
  nights?: number;
  checkIn?: string;
  checkOut?: string;
  idempotencyKey?: string;
}

export interface BookingRow {
  id: string;
  status: string;
  propertyId: string;
  grossAmountHalalahs: string;
  currency: string;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  confirmedAt: string | null;
  createdAt: string;
}

export async function createBooking(input: CreateBookingInput): Promise<{ booking: BookingRow }> {
  const token = getCustomerToken();
  if (!token) throw new BookingApiError('UNAUTHORIZED', 'sign in first', 401);
  const res = await fetch(`${API_BASE}/v1/bookings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseError(res);
  return await res.json() as { booking: BookingRow };
}

export interface StartPaymentResult {
  paymentId: string;
  providerPaymentId: string;
  redirectUrl?: string;
}

export async function startPayment(input: {
  bookingId: string;
  idempotencyKey?: string;
}): Promise<StartPaymentResult> {
  const token = getCustomerToken();
  if (!token) throw new BookingApiError('UNAUTHORIZED', 'sign in first', 401);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;
  const res = await fetch(`${API_BASE}/v1/payments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ bookingId: input.bookingId }),
  });
  if (!res.ok) throw await parseError(res);
  return await res.json() as StartPaymentResult;
}

/** Dev / sandbox-only: completes a sandbox payment by looping back through
 *  the real /v1/payments/webhook endpoint. Fails loudly on prod builds
 *  because the backend only registers this route on NODE_ENV={development,test}. */
export async function captureSandboxPayment(providerPaymentId: string): Promise<void> {
  const token = getCustomerToken();
  if (!token) throw new BookingApiError('UNAUTHORIZED', 'sign in first', 401);
  const res = await fetch(
    `${API_BASE}/v1/dev/sandbox/capture/${encodeURIComponent(providerPaymentId)}`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw await parseError(res);
}

/** Dev / sandbox-only equivalent for the failed-payment path. We mark the
 *  sandbox row failed then POST a `payment.failed` webhook back through the
 *  real route so the booking + payment reach the correct status. */
export async function failSandboxPayment(providerPaymentId: string): Promise<void> {
  const token = getCustomerToken();
  if (!token) throw new BookingApiError('UNAUTHORIZED', 'sign in first', 401);
  const res = await fetch(
    `${API_BASE}/v1/dev/sandbox/fail/${encodeURIComponent(providerPaymentId)}`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw await parseError(res);
}

export async function fetchBooking(id: string): Promise<BookingRow & { payments?: Array<{ id: string; status: string }>; invoice?: { id: string } | null }> {
  const token = getCustomerToken();
  if (!token) throw new BookingApiError('UNAUTHORIZED', 'sign in first', 401);
  const res = await fetch(`${API_BASE}/v1/bookings/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await parseError(res);
  return await res.json() as BookingRow & { payments?: Array<{ id: string; status: string }>; invoice?: { id: string } | null };
}

export function newIdempotencyKey(): string {
  // Short, URL-safe, enough entropy for one checkout attempt.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
