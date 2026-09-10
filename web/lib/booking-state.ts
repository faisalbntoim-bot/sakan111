// Booking-flow state persisted per-property via sessionStorage.
//
// We keep this in sessionStorage (not localStorage) so it clears when the
// tab closes — the flow is transient by design and there's no benefit to
// leaking half-filled bookings across sessions. The key is scoped by
// property id so switching properties doesn't bleed state.
//
// Server-side, all reads return null and writes are no-ops — this is the
// same shape sessionStorage would give in a private/blocked context, so
// the callers already handle it.

export type BookingMode = 'daily' | 'annual';

export type BookingState = {
  propertyId: string;
  mode: BookingMode;
  checkIn: string | null;   // YYYY-MM-DD (daily = arrival, annual = contract start)
  checkOut: string | null;  // YYYY-MM-DD (daily = departure; annual = derived from months)
  months: number;           // annual only — contract length (12/24/36)
  adults: number;
  children: number;
  infants: number;
};

const SERVICE_FEE_RATE = 0.12; // 12% platform service fee (mirrors SPA)
const VAT_RATE = 0.15;         // 15% Saudi VAT (mirrors SPA)

const keyFor = (id: string) => `sh:booking:${id}`;

export function readBooking(id: string, mode: BookingMode = 'daily'): BookingState {
  if (typeof window === 'undefined') return blankBooking(id, mode);
  try {
    const raw = window.sessionStorage.getItem(keyFor(id));
    if (!raw) return blankBooking(id, mode);
    const parsed = JSON.parse(raw) as Partial<BookingState>;
    // If the mode in URL differs from what's stored (e.g. user switched
    // annual↔daily on the property page), the URL wins so we don't
    // resurrect stale dates from the other mode.
    return { ...blankBooking(id, mode), ...parsed, propertyId: id, mode };
  } catch {
    return blankBooking(id, mode);
  }
}

export function writeBooking(state: BookingState): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(keyFor(state.propertyId), JSON.stringify(state));
  } catch {
    // Storage disabled — flow still works in-memory during the current page.
  }
}

export function blankBooking(id: string, mode: BookingMode = 'daily'): BookingState {
  return { propertyId: id, mode, checkIn: null, checkOut: null, months: 12, adults: 1, children: 0, infants: 0 };
}

/** Add a month count to a YYYY-MM-DD, returning YYYY-MM-DD. */
export function addMonths(ymd: string, months: number): string {
  const d = new Date(ymd + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function nightsBetween(checkIn: string | null, checkOut: string | null): number {
  if (!checkIn || !checkOut) return 0;
  const a = new Date(checkIn + 'T00:00:00');
  const b = new Date(checkOut + 'T00:00:00');
  const ms = b.getTime() - a.getTime();
  if (Number.isNaN(ms) || ms <= 0) return 0;
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

export type PriceBreakdown = {
  nights: number;
  nightlyPrice: number;
  subtotal: number;
  cleaning: number;
  serviceFee: number;
  vat: number;
  total: number;
};

export function computePrice(nightlyPrice: number, nights: number, cleaning: number): PriceBreakdown {
  const subtotal = nightlyPrice * nights;
  // Service fee applies to the stay subtotal only. This matches the SPA
  // breakdown (bookSheetV2Html / bsv3 payBody) so both surfaces show
  // identical totals for the same inputs — no double-counting cleaning.
  const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE);
  const preVat = subtotal + cleaning + serviceFee;
  const vat = Math.round(preVat * VAT_RATE);
  const total = preVat + vat;
  return { nights, nightlyPrice, subtotal, cleaning, serviceFee, vat, total };
}

const AR_NUM = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'] as const;
export function nfA(n: number): string {
  return String(Math.round(n)).replace(/\d/g, d => AR_NUM[Number(d)] ?? d);
}

const AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'] as const;
const AR_DAYS   = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'] as const;

export function formatArabicDate(ymd: string | null): string {
  if (!ymd) return '—';
  const d = new Date(ymd + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return `${nfA(d.getDate())} ${AR_MONTHS[d.getMonth()] ?? ''} ${nfA(d.getFullYear())}`;
}

export function formatArabicDayDate(ymd: string | null): string {
  if (!ymd) return '—';
  const d = new Date(ymd + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return `${AR_DAYS[d.getDay()] ?? ''} · ${nfA(d.getDate())} ${AR_MONTHS[d.getMonth()] ?? ''}`;
}
