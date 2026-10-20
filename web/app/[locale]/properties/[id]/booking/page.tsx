'use client';


import { use } from 'react';
/**
 * Booking flow — one scrollable page.
 *
 * Two property sources, same UI:
 *   - Local fixture ids (0..14, the SPA's demo list in lib/properties)
 *     render the frontend-only demo (no backend call, no DB row).
 *   - Backend CUIDs (anything that doesn't match a fixture id) fetch
 *     the real Property record from /v1/properties/:id and the pay
 *     button drives the real backend: /v1/bookings → /v1/payments →
 *     (sandbox-only) /v1/dev/sandbox/capture → confirmation page.
 *
 * The review bottom-sheet contains an inline OTP login step when the
 * user is not signed in — the test's "click the pay button" never
 * leaves this route.
 *
 * Double-click protection on the pay button: a per-attempt
 * idempotencyKey is generated the first time the user clicks pay for a
 * given review session. If the button is clicked twice fast the second
 * fetch is suppressed by `payBusy`; if the user re-enters the sheet,
 * a fresh key is minted so a legitimate retry is a new attempt.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getProperty, type PropertyRecord } from '@/lib/properties';
import {
  readBooking,
  writeBooking,
  nightsBetween,
  computePrice,
  formatArabicDate,
  formatArabicDayDate,
  nfA,
  addMonths,
  type BookingState,
  type BookingMode,
} from '@/lib/booking-state';
import { BookingChrome } from '@/components/booking/BookingChrome';
import { PropertyMiniCard } from '@/components/booking/PropertyMiniCard';
import { RtlCalendar } from '@/components/booking/RtlCalendar';
import { GuestsPicker } from '@/components/booking/GuestsPicker';
import { CardPayForm } from '@/components/booking/CardPayForm';
import { SimilarPropertiesSection } from '@/components/SimilarPropertiesSection';
import {
  BookingApiError,
  captureSandboxPayment,
  createBooking,
  failSandboxPayment,
  fetchBackendProperty,
  getCustomerToken,
  newIdempotencyKey,
  requestCustomerOtp,
  startPayment,
  verifyCustomerOtp,
} from '@/lib/booking-api';

const ANNUAL_MONTHLY_FROM_DAILY = 30 * 0.55;
const VAT_RATE = 0.15;
const SERVICE_FEE_RATE = 0.05;

const MONTH_CHOICES = [12, 24, 36] as const;

const PHONE_RX = /^\+?[0-9]{8,15}$/;
const CODE_RX = /^[0-9]{6}$/;

/** Fixture ids are the 15 single-digit strings 0..14. Anything else is a
 *  backend CUID and should round-trip the real backend.
 *
 *  Local fixtures are a design-only sandbox: they never create a booking
 *  row. In production builds we refuse to render them at all (see the
 *  guard in BookingPage). The flag below is inlined at build time, so
 *  the dead "demo fixture" branch is tree-shaken off the prod bundle. */
const ALLOW_LOCAL_FIXTURE =
  process.env.NEXT_PUBLIC_SAKAN_ALLOW_FIXTURE_BOOKING === 'true' ||
  process.env.NEXT_PUBLIC_SAKAN_E2E === 'true';

function isLocalFixtureId(id: string): boolean {
  return /^\d{1,2}$/.test(id) && getProperty(id) !== undefined;
}

/** Translate a backend Property row into a PropertyRecord shape the
 *  existing booking UI already knows how to render. We derive a daily
 *  rate from priceHalalahs when the pricing period is DAY, otherwise
 *  pick a sensible default so the SAR/night strip is not empty. */
function backendToRecord(p: Awaited<ReturnType<typeof fetchBackendProperty>>, id: string): PropertyRecord {
  const priceSAR = p.priceHalalahs ? Number(BigInt(p.priceHalalahs) / 100n) : 0;
  const dailyRate = p.pricePeriod === 'DAY' ? priceSAR : Math.round(priceSAR / 30);
  const beds = p.bedrooms ?? 1;
  return {
    id,
    name: `${p.category || 'عقار'} ${beds} غرف`,
    neighborhood: p.district || p.city || '',
    city: p.city || 'الرياض',
    category: p.category || 'شقة',
    area: p.areaSqm ?? 0,
    rooms: beds,
    bath: p.bathrooms ?? 1,
    dailyRate: Math.max(dailyRate, 100),
    cleaning: 100,
    rating: 4.8,
    maxGuests: Math.max(beds * 2, 2),
    photoIndex: 1,
    shortTerm: p.purpose !== 'sale',
    booked: [],
    desc: `${p.category || 'عقار'} في ${p.district || p.city || 'الرياض'}.`,
  };
}

type PropertyState =
  | { kind: 'loading' }
  | { kind: 'local'; record: PropertyRecord }
  | { kind: 'backend'; record: PropertyRecord; backendId: string }
  | { kind: 'missing' };

export default function BookingPage({ params: _params }: { params: Promise<{ locale: string; id: string }> }) {
  const params = use(_params);
  const router = useRouter();
  const search = useSearchParams();
  const mode: BookingMode = search.get('mode') === 'annual' ? 'annual' : 'daily';

  // Resolve the property either from the local fixture (dev/E2E only)
  // or from the backend. A fixture id reaching the prod bundle is a
  // broken SPA link; we treat it as missing so no booking widget shows
  // over demo data a visitor cannot actually book.
  const [propState, setPropState] = useState<PropertyState>(() => {
    if (ALLOW_LOCAL_FIXTURE && isLocalFixtureId(params.id)) {
      const local = getProperty(params.id);
      if (local) return { kind: 'local', record: local };
    }
    if (!ALLOW_LOCAL_FIXTURE && isLocalFixtureId(params.id)) {
      return { kind: 'missing' };
    }
    return { kind: 'loading' };
  });

  useEffect(() => {
    if (propState.kind !== 'loading') return;
    let alive = true;
    void (async () => {
      try {
        const p = await fetchBackendProperty(params.id);
        if (!alive) return;
        setPropState({ kind: 'backend', record: backendToRecord(p, params.id), backendId: p.id });
      } catch {
        if (!alive) return;
        setPropState({ kind: 'missing' });
      }
    })();
    return () => { alive = false; };
  }, [params.id, propState.kind]);

  const property = propState.kind === 'local' || propState.kind === 'backend' ? propState.record : null;

  const [state, setState] = useState<BookingState>(() => ({
    propertyId: params.id,
    mode,
    checkIn: null,
    checkOut: null,
    months: 12,
    adults: 1,
    children: 0,
    infants: 0,
  }));
  const [reviewOpen, setReviewOpen] = useState(false);
  const [payMethod, setPayMethod] = useState<'mada'|'apple'|'card'|'stc'>('mada');
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [payStage, setPayStage] = useState<'idle' | 'booking' | 'paying' | 'done' | 'failed'>('idle');

  // Inline login state. Lives alongside the review sheet so the user never
  // leaves the booking page to authenticate.
  const [authState, setAuthState] = useState<'checking' | 'needs-phone' | 'needs-code' | 'ready'>(
    () => (typeof window === 'undefined' ? 'checking' : (getCustomerToken() ? 'ready' : 'needs-phone')),
  );
  const [loginPhone, setLoginPhone] = useState('');
  const [loginName, setLoginName] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [loginRequestId, setLoginRequestId] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Guard payment: an idempotencyKey minted when the user first clicks
  // pay. Re-minted when the review sheet opens anew so a legitimate
  // retry after sheet close/reopen is a new attempt, but a fast double
  // click inside one sheet session hits the SAME key → the backend's
  // withIdempotency() short-circuits the duplicate.
  const idempotencyKeyRef = useRef<string | null>(null);
  const payInFlightRef = useRef(false);
  // Reused across retries inside one sheet session: once the booking
  // row exists, retrying the payment never re-creates the booking (that
  // would 409 against its own just-reserved dates and leak draft rows).
  const bookingIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (reviewOpen) {
      idempotencyKeyRef.current = newIdempotencyKey();
      bookingIdRef.current = null;
      setPayError(null);
      setPayStage('idle');
      // Re-check the token every time we open the sheet (user may have
      // signed out in another tab).
      setAuthState(getCustomerToken() ? 'ready' : 'needs-phone');
    }
  }, [reviewOpen]);

  useEffect(() => {
    if (property) {
      setState(readBooking(params.id, mode));
    }
  }, [params.id, mode, property]);

  useEffect(() => {
    writeBooking(state);
  }, [state]);

  useEffect(() => {
    if (reviewOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [reviewOpen]);

  const nights = nightsBetween(state.checkIn, state.checkOut);
  const dailyPrice = useMemo(
    () => property ? computePrice(property.dailyRate, nights, property.cleaning) : null,
    [property, nights],
  );

  const annualPrice = useMemo(() => {
    if (!property || mode !== 'annual') return null;
    const monthlyRate = Math.round(property.dailyRate * ANNUAL_MONTHLY_FROM_DAILY);
    const subtotal = monthlyRate * state.months;
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE);
    const vat = Math.round((subtotal + serviceFee) * VAT_RATE);
    const total = subtotal + serviceFee + vat;
    return { monthlyRate, subtotal, serviceFee, vat, total };
  }, [property, mode, state.months]);

  const isAnnual = mode === 'annual';
  const canBook = !!property && (
    isAnnual
      ? !!state.checkIn && state.months > 0 && state.adults >= 1
      : nights > 0 && state.adults >= 1
  );

  const onDatesChange = useCallback((checkIn: string | null, checkOut: string | null) =>
    setState(prev => ({ ...prev, checkIn, checkOut })), []);
  const onAnnualStart = useCallback((checkIn: string | null) =>
    setState(prev => ({ ...prev, checkIn })), []);
  const onMonths = useCallback((m: number) =>
    setState(prev => ({ ...prev, months: m })), []);
  const onGuestsChange = useCallback((next: { adults: number; children: number; infants: number }) =>
    setState(prev => ({ ...prev, ...next })), []);

  const guestsSummary = useMemo(() => {
    const parts: string[] = [`${nfA(state.adults)} بالغ`];
    if (state.children > 0) parts.push(`${nfA(state.children)} طفل`);
    if (state.infants > 0) parts.push(`${nfA(state.infants)} رضيع`);
    return parts.join(' · ');
  }, [state.adults, state.children, state.infants]);

  const switchMode = useCallback((m: BookingMode) => {
    if (property) router.replace(`/${params.locale}/properties/${params.id}/booking?mode=${m}`);
  }, [params.id, params.locale, property, router]);

  const stickyTotal = isAnnual ? (annualPrice?.total ?? 0) : (dailyPrice?.total ?? 0);
  // The subtotal is what the backend's /v1/bookings expects as
  // `grossAmount` (platform fee + VAT get added server-side on
  // /v1/payments). stickyTotal is only for the display strip.
  const bookingGross = isAnnual ? (annualPrice?.subtotal ?? 0) : (dailyPrice?.subtotal ?? 0);
  const contractEnd = isAnnual && state.checkIn ? addMonths(state.checkIn, state.months) : null;

  const requestLoginCode = useCallback(async () => {
    setLoginError(null);
    const trimmed = loginPhone.trim();
    if (!PHONE_RX.test(trimmed)) {
      setLoginError('رقم الجوال غير صحيح. المثال: +9665XXXXXXXX');
      return;
    }
    setLoginBusy(true);
    try {
      const r = await requestCustomerOtp(trimmed);
      setLoginRequestId(r.requestId);
      setAuthState('needs-code');
    } catch (e) {
      setLoginError(e instanceof BookingApiError ? e.message : 'تعذّر طلب رمز التحقق.');
    } finally { setLoginBusy(false); }
  }, [loginPhone]);

  const verifyLoginCode = useCallback(async () => {
    setLoginError(null);
    if (!loginRequestId) { setAuthState('needs-phone'); return; }
    if (!CODE_RX.test(loginCode.trim())) {
      setLoginError('الرمز يجب أن يكون 6 أرقام.');
      return;
    }
    setLoginBusy(true);
    try {
      await verifyCustomerOtp({
        requestId: loginRequestId,
        phone: loginPhone.trim(),
        code: loginCode.trim(),
        nameAr: loginName.trim() || undefined,
      });
      setAuthState('ready');
      setLoginCode('');
    } catch (e) {
      setLoginError(e instanceof BookingApiError ? e.message : 'تعذّر التحقق من الرمز.');
    } finally { setLoginBusy(false); }
  }, [loginRequestId, loginPhone, loginCode, loginName]);

  const payNow = useCallback(async () => {
    // Hard double-click guard — both React state and a sync ref so a
    // double tap in one event-loop tick does not reach the fetch.
    if (payInFlightRef.current || payBusy) return;
    if (propState.kind !== 'backend') {
      setPayError('هذا عرض تجريبي للتصميم فقط. الحجز الفعلي متاح على الإعلانات المنشورة من المالكين.');
      return;
    }
    if (authState !== 'ready') {
      setPayError('يرجى تسجيل الدخول للمتابعة.');
      return;
    }
    if (stickyTotal <= 0 || !canBook) {
      setPayError('أكمل بيانات الحجز قبل الدفع.');
      return;
    }
    payInFlightRef.current = true;
    setPayBusy(true);
    setPayError(null);
    setPayStage('booking');

    const idempotencyKey = idempotencyKeyRef.current || newIdempotencyKey();
    idempotencyKeyRef.current = idempotencyKey;

    try {
      let bookingId = bookingIdRef.current;
      if (!bookingId) {
        const checkIn = state.checkIn ? new Date(state.checkIn).toISOString() : undefined;
        const checkOut = state.checkOut ? new Date(state.checkOut).toISOString() : undefined;
        const booking = await createBooking({
          propertyId: propState.backendId,
          transactionType: isAnnual ? 'LONG_TERM_RENTAL' : 'DAILY_RENTAL',
          grossAmount: String(bookingGross),
          currency: 'SAR',
          nights: isAnnual ? undefined : nights,
          checkIn,
          checkOut: isAnnual ? undefined : checkOut,
          idempotencyKey,
        });
        bookingId = booking.booking.id;
        bookingIdRef.current = bookingId;
      }
      setPayStage('paying');
      const payment = await startPayment({
        bookingId,
        idempotencyKey,
      });
      if (payment.providerPaymentId.startsWith('sb_pay_')) {
        // Sandbox has no hosted checkout UI to drive. Loopback through
        // the dev-only route only exists in dev/E2E builds; in a prod
        // bundle calling it would 404 (good: no silent fake-success).
        if (!ALLOW_LOCAL_FIXTURE) {
          throw new BookingApiError(
            'NO_GATEWAY',
            'بوابة الدفع الفعلية غير مُهيّأة. لم يتم خصم أي مبلغ.',
            503,
          );
        }
        await captureSandboxPayment(payment.providerPaymentId);
      } else if (payment.redirectUrl) {
        // Real PSP (Moyasar / Tap): hand the user to the hosted checkout.
        window.location.href = payment.redirectUrl;
        return;
      }
      setPayStage('done');
      router.push(`/${params.locale}/bookings/${bookingId}`);
    } catch (e) {
      setPayStage('failed');
      if (e instanceof BookingApiError) {
        if (e.httpStatus === 401) {
          setPayError('انتهت الجلسة. يرجى تسجيل الدخول من جديد.');
          setAuthState('needs-phone');
        } else if (e.httpStatus === 409) {
          // Overlap or state conflict — the server message is already
          // user-facing Arabic for the overlap case.
          setPayError(e.message || 'العقار غير متاح في هذه التواريخ.');
        } else if (e.httpStatus === 400) {
          setPayError(e.message || 'تحقق من بيانات الحجز.');
        } else {
          setPayError('تعذّر إكمال الدفع. حاول مرة أخرى.');
        }
      } else {
        setPayError('تعذّر الوصول إلى الخادم. تحقق من الاتصال وأعد المحاولة.');
      }
      // Mint a fresh idempotencyKey for the next retry so a payment
      // that failed mid-stream does not resume a stuck attempt.
      idempotencyKeyRef.current = newIdempotencyKey();
    } finally {
      payInFlightRef.current = false;
      setPayBusy(false);
    }
  }, [
    authState, canBook, isAnnual, nights, params.locale, payBusy, propState,
    router, state.checkIn, state.checkOut, stickyTotal,
  ]);

  // Dev-only "simulate payment failure" button (visible on sandbox builds).
  const simulateFailureIfSandbox = useCallback(async () => {
    if (payInFlightRef.current || payBusy) return;
    if (propState.kind !== 'backend' || authState !== 'ready' || stickyTotal <= 0) return;
    payInFlightRef.current = true;
    setPayBusy(true);
    setPayError(null);
    setPayStage('booking');
    const idempotencyKey = newIdempotencyKey();
    idempotencyKeyRef.current = idempotencyKey;
    try {
      let bookingId = bookingIdRef.current;
      if (!bookingId) {
        const checkIn = state.checkIn ? new Date(state.checkIn).toISOString() : undefined;
        const checkOut = state.checkOut ? new Date(state.checkOut).toISOString() : undefined;
        const booking = await createBooking({
          propertyId: propState.backendId,
          transactionType: isAnnual ? 'LONG_TERM_RENTAL' : 'DAILY_RENTAL',
          grossAmount: String(bookingGross),
          currency: 'SAR',
          nights: isAnnual ? undefined : nights,
          checkIn,
          checkOut: isAnnual ? undefined : checkOut,
          idempotencyKey,
        });
        bookingId = booking.booking.id;
        bookingIdRef.current = bookingId;
      }
      setPayStage('paying');
      const payment = await startPayment({
        bookingId,
        idempotencyKey,
      });
      await failSandboxPayment(payment.providerPaymentId);
      setPayStage('failed');
      setPayError('فشلت عملية الدفع التجريبية. يمكنك إعادة المحاولة.');
      idempotencyKeyRef.current = newIdempotencyKey();
    } catch (e) {
      setPayStage('failed');
      setPayError(e instanceof BookingApiError ? e.message : 'خطأ في محاكاة الفشل.');
      idempotencyKeyRef.current = newIdempotencyKey();
    } finally {
      payInFlightRef.current = false;
      setPayBusy(false);
    }
  }, [authState, isAnnual, nights, payBusy, propState, state.checkIn, state.checkOut, stickyTotal]);

  if (propState.kind === 'loading') {
    return (
      <>
        <BookingChrome title="إكمال الحجز" fallbackHref={`/${params.locale}`} />
        <div className="bkp"><div className="bk-missing" role="status">جارٍ تحميل العقار…</div></div>
      </>
    );
  }

  if (propState.kind === 'missing' || !property) {
    return (
      <>
        <BookingChrome title="إكمال الحجز" fallbackHref={`/${params.locale}`} />
        <div className="bkp">
          <div className="bk-missing">
            <b>لم يتم العثور على هذا العقار</b>
            <span>ربما تم حذفه أو أن الرابط غير صحيح.</span>
            <a href={`/${params.locale}`}>العودة للصفحة الرئيسية</a>
          </div>
        </div>
      </>
    );
  }

  const isBackendRow = propState.kind === 'backend';
  const sandboxVisible = isBackendRow && process.env.NEXT_PUBLIC_SAKAN_E2E === 'true';

  return (
    <>
      <BookingChrome title="إكمال الحجز" fallbackHref={`/${params.locale}`} />

      <main className="bkp">
        <PropertyMiniCard property={property} />
        <div className="bkc-price-strip">
          <div>{isAnnual ? 'الإيجار الشهري (تقديري)' : 'سعر الليلة'}</div>
          <b>
            {isAnnual
              ? nfA(Math.round(property.dailyRate * ANNUAL_MONTHLY_FROM_DAILY))
              : nfA(property.dailyRate)}
            {' '}<small>{isAnnual ? 'ر.س/شهر' : 'ر.س'}</small>
          </b>
        </div>

        {property.shortTerm && (
          <div className="bk-mode-toggle" role="tablist" aria-label="نوع الإيجار">
            <button type="button" role="tab" aria-selected={!isAnnual} className={!isAnnual ? 'on' : ''} onClick={() => switchMode('daily')}>حجز يومي</button>
            <button type="button" role="tab" aria-selected={isAnnual} className={isAnnual ? 'on' : ''} onClick={() => switchMode('annual')}>إيجار سنوي</button>
          </div>
        )}

        <section className="bks">
          <h2 className="bks-title">{isAnnual ? 'بداية العقد ومدته' : 'اختر التواريخ'}</h2>
          {isAnnual ? (
            <>
              {state.checkIn && (
                <div className="dates-summary">
                  <div className="ds-cell"><small>بداية العقد</small><b>{formatArabicDate(state.checkIn)}</b></div>
                  <div className="ds-arrow" aria-hidden="true">←</div>
                  <div className="ds-cell"><small>نهاية العقد</small><b>{formatArabicDate(contractEnd)}</b></div>
                  <div className="ds-nights">{nfA(state.months)} شهرًا</div>
                </div>
              )}
              {!state.checkIn && <p className="bks-sub">اختر تاريخ بداية العقد من التقويم — بقية المدة تُحسب تلقائيًا من الأشهر.</p>}
              <RtlCalendar bookedDays={[]} checkIn={state.checkIn} checkOut={null} onChange={(ci) => onAnnualStart(ci)} />
              <div className="bk-annual-months" role="radiogroup" aria-label="مدة العقد">
                {MONTH_CHOICES.map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={state.months === m}
                    className={state.months === m ? 'on' : ''} onClick={() => onMonths(m)}>
                    {nfA(m)} شهر<small>{m === 12 ? 'سنة واحدة' : m === 24 ? 'سنتان' : 'ثلاث سنوات'}</small>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              {nights > 0 ? (
                <div className="dates-summary">
                  <div className="ds-cell"><small>الوصول</small><b>{formatArabicDate(state.checkIn)}</b></div>
                  <div className="ds-arrow" aria-hidden="true">←</div>
                  <div className="ds-cell"><small>المغادرة</small><b>{formatArabicDate(state.checkOut)}</b></div>
                  <div className="ds-nights">{nfA(nights)} ليالٍ</div>
                </div>
              ) : (
                <p className="bks-sub">اختر تاريخ الوصول ثم تاريخ المغادرة على التقويم.</p>
              )}
              <RtlCalendar bookedDays={property.booked} checkIn={state.checkIn} checkOut={state.checkOut} onChange={onDatesChange} />
            </>
          )}
        </section>

        <section className="bks">
          <h2 className="bks-title">الضيوف</h2>
          <GuestsPicker adults={state.adults} children={state.children} infants={state.infants} maxGuests={property.maxGuests} onChange={onGuestsChange} />
        </section>

        <section className="bks">
          <h2 className="bks-title">تفاصيل السعر</h2>
          {isAnnual && annualPrice && state.checkIn ? (
            <div className="bk-price" data-testid="bk-price-detail">
              <div className="pr-row"><span>{nfA(annualPrice.monthlyRate)} ر.س × {nfA(state.months)} شهر</span><span>{nfA(annualPrice.subtotal)} ر.س</span></div>
              <div className="pr-row"><span>رسوم خدمة سكن هوب</span><span>{nfA(annualPrice.serviceFee)} ر.س</span></div>
              <div className="pr-row"><span>ضريبة القيمة المضافة</span><span>{nfA(annualPrice.vat)} ر.س</span></div>
              <div className="pr-row total"><span>الإجمالي السنوي</span><span className="pr-v" data-testid="bk-price-total">{nfA(annualPrice.total)} ر.س</span></div>
            </div>
          ) : !isAnnual && dailyPrice && nights > 0 ? (
            <div className="bk-price" data-testid="bk-price-detail">
              <div className="pr-row"><span>{nfA(property.dailyRate)} ر.س × {nfA(nights)} ليالٍ</span><span>{nfA(dailyPrice.subtotal)} ر.س</span></div>
              <div className="pr-row"><span>رسوم خدمة سكن هوب</span><span>{nfA(dailyPrice.serviceFee)} ر.س</span></div>
              <div className="pr-row"><span>ضريبة القيمة المضافة</span><span>{nfA(dailyPrice.vat)} ر.س</span></div>
              <div className="pr-row total"><span>الإجمالي</span><span className="pr-v" data-testid="bk-price-total">{nfA(dailyPrice.total)} ر.س</span></div>
            </div>
          ) : (
            <p className="bks-sub">
              {isAnnual ? 'اختر بداية العقد لعرض السعر الإجمالي.' : 'حدّد التواريخ لعرض السعر الإجمالي فورًا هنا.'}
            </p>
          )}
        </section>

        <section className="bks">
          <h2 className="bks-title">معلومات الحجز</h2>
          <ul className="bk-info-list">
            {isAnnual ? (
              <>
                <li><span className="ic" aria-hidden="true">📄</span><div><b>عقد إيجار موثّق</b><small>يُوثّق العقد عبر منصة إيجار</small></div></li>
                <li><span className="ic" aria-hidden="true">💰</span><div><b>الدفعة الأولى</b><small>شهر مقدّم + شهر تأمين مسترد</small></div></li>
                <li><span className="ic" aria-hidden="true">↩️</span><div><b>سياسة الإلغاء</b><small>إلغاء مجاني قبل توقيع العقد</small></div></li>
              </>
            ) : (
              <>
                <li><span className="ic" aria-hidden="true">🕒</span><div><b>تسجيل الوصول</b><small>الساعة ٣:٠٠ عصرًا</small></div></li>
                <li><span className="ic" aria-hidden="true">🕚</span><div><b>تسجيل المغادرة</b><small>الساعة ١١:٠٠ صباحًا</small></div></li>
                <li><span className="ic" aria-hidden="true">↩️</span><div><b>سياسة الإلغاء</b><small>إلغاء مجاني قبل ٤٨ ساعة من الوصول</small></div></li>
                <li><span className="ic" aria-hidden="true">🏠</span><div><b>قواعد العقار</b><small>ممنوع التدخين · هدوء بعد الساعة ١١ ليلًا</small></div></li>
              </>
            )}
          </ul>
        </section>

        <SimilarPropertiesSection propertyId={params.id} limit={6} />
      </main>

      <div className="bk-sticky">
        <div className="bk-sticky-inner">
          <div className="bk-sticky-tx">
            {stickyTotal > 0 ? (
              <>
                <b>{nfA(stickyTotal)} <small>ر.س</small></b>
                <small>
                  {isAnnual
                    ? `${nfA(state.months)} شهرًا · شامل الرسوم`
                    : `${nfA(nights)} ليالٍ · شامل الرسوم`}
                </small>
              </>
            ) : (
              <>
                <b>{isAnnual ? 'اختر بداية العقد' : 'حدّد التواريخ للمتابعة'}</b>
                <small>{isAnnual ? `الإيجار الشهري ~${nfA(Math.round(property.dailyRate * ANNUAL_MONTHLY_FROM_DAILY))} ر.س` : `سعر الليلة ${nfA(property.dailyRate)} ر.س`}</small>
              </>
            )}
          </div>
          <button
            className="bk-cta"
            data-testid="bk-confirm-cta"
            disabled={!canBook}
            onClick={() => setReviewOpen(true)}
          >
            تأكيد الحجز
          </button>
        </div>
      </div>

      <div
        className={`bk-review-overlay ${reviewOpen ? 'open' : ''}`}
        onClick={() => setReviewOpen(false)}
        aria-hidden={!reviewOpen}
      >
        <div className="bk-review-sheet" onClick={(e) => e.stopPropagation()} data-testid="bk-review-sheet">
          <div className="brs-handle" />
          <div className="brs-head">
            <b>مراجعة الحجز</b>
            <button className="brs-close" onClick={() => setReviewOpen(false)} aria-label="إغلاق">✕</button>
          </div>
          <div className="brs-body">
            <PropertyMiniCard property={property} />
            <div className="brs-grid">
              {isAnnual ? (
                <>
                  <div className="brs-row"><span className="brs-k">بداية العقد</span><span className="brs-v">{formatArabicDayDate(state.checkIn)}</span></div>
                  <div className="brs-row"><span className="brs-k">نهاية العقد</span><span className="brs-v">{formatArabicDayDate(contractEnd)}</span></div>
                  <div className="brs-row"><span className="brs-k">المدة</span><span className="brs-v">{nfA(state.months)} شهرًا</span></div>
                </>
              ) : (
                <>
                  <div className="brs-row"><span className="brs-k">الوصول</span><span className="brs-v">{formatArabicDayDate(state.checkIn)}</span></div>
                  <div className="brs-row"><span className="brs-k">المغادرة</span><span className="brs-v">{formatArabicDayDate(state.checkOut)}</span></div>
                  <div className="brs-row"><span className="brs-k">عدد الليالي</span><span className="brs-v">{nfA(nights)}</span></div>
                </>
              )}
              <div className="brs-row"><span className="brs-k">الضيوف</span><span className="brs-v">{guestsSummary}</span></div>
              <div className="brs-row total"><span className="brs-k">الإجمالي</span><span className="brs-v" data-testid="brs-total">{nfA(stickyTotal)} ر.س</span></div>
            </div>

            {isBackendRow && authState !== 'ready' && (
              <div className="brs-login" data-testid="brs-login">
                <div className="brs-login-head">يتطلب الدفع تسجيل الدخول</div>
                {authState === 'needs-phone' && (
                  <form onSubmit={(e) => { e.preventDefault(); void requestLoginCode(); }} noValidate>
                    <label className="ol-field">
                      <span>رقم الجوال</span>
                      <input
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        value={loginPhone}
                        onChange={(e) => setLoginPhone(e.target.value)}
                        placeholder="+9665XXXXXXXX"
                        disabled={loginBusy}
                        data-testid="brs-login-phone"
                      />
                    </label>
                    <label className="ol-field">
                      <span>الاسم (اختياري)</span>
                      <input
                        type="text"
                        value={loginName}
                        onChange={(e) => setLoginName(e.target.value)}
                        placeholder="مثال: فهد العبدالله"
                        disabled={loginBusy}
                      />
                    </label>
                    {loginError && <div role="alert" className="ol-alert">{loginError}</div>}
                    <button
                      type="submit"
                      className="ol-btn ol-btn-primary"
                      disabled={loginBusy}
                      data-testid="brs-login-request"
                    >
                      {loginBusy ? 'جارٍ الإرسال…' : 'أرسل رمز التحقق'}
                    </button>
                  </form>
                )}
                {authState === 'needs-code' && (
                  <form onSubmit={(e) => { e.preventDefault(); void verifyLoginCode(); }} noValidate>
                    <p className="ol-muted">أرسلنا رمزًا إلى <b>{loginPhone}</b>.</p>
                    <label className="ol-field">
                      <span>رمز التحقق</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]{6}"
                        maxLength={6}
                        value={loginCode}
                        onChange={(e) => setLoginCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="••••••"
                        disabled={loginBusy}
                        data-testid="brs-login-code"
                      />
                    </label>
                    {loginError && <div role="alert" className="ol-alert">{loginError}</div>}
                    <div className="ol-row">
                      <button type="button" className="ol-btn" onClick={() => setAuthState('needs-phone')} disabled={loginBusy}>رجوع</button>
                      <button
                        type="submit"
                        className="ol-btn ol-btn-primary"
                        disabled={loginBusy || loginCode.length !== 6}
                        data-testid="brs-login-verify"
                      >
                        {loginBusy ? 'جارٍ التحقّق…' : 'دخول'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {authState === 'ready' && (
              <>
                <div className="brs-methods-title">طريقة الدفع</div>
                <div className="pay-methods-v3" role="radiogroup" aria-label="طريقة الدفع">
                  {([
                    { k: 'mada' as const,  label: 'مدى' },
                    { k: 'apple' as const, label: 'Apple Pay' },
                    { k: 'card' as const,  label: 'بطاقة' },
                    { k: 'stc' as const,   label: 'STC Pay' },
                  ]).map((m) => (
                    <button
                      key={m.k}
                      type="button"
                      role="radio"
                      aria-checked={payMethod === m.k}
                      className={`pm-v3 ${payMethod === m.k ? 'on' : ''}`}
                      onClick={() => setPayMethod(m.k)}
                    >
                      <span className={`pm-v3-ic pm-v3-${m.k}`} aria-hidden="true">
                        {m.k === 'mada' && <span className="pm-v3-mada-lbl">مدى</span>}
                        {m.k === 'stc' && <span className="pm-v3-stc-lbl">STC</span>}
                      </span>
                      <span className="pm-v3-tx"><b>{m.label}</b></span>
                    </button>
                  ))}
                </div>
                {payMethod === 'card' && <CardPayForm />}
              </>
            )}
          </div>

          {payError && (
            <div role="alert" className="brs-pay-error" data-testid="brs-pay-error">{payError}</div>
          )}

          <button
            className="brs-cta"
            disabled={payBusy || stickyTotal <= 0 || authState !== 'ready' || !isBackendRow}
            onClick={payNow}
            data-testid="brs-pay"
          >
            {payBusy
              ? (payStage === 'booking' ? 'جارٍ إنشاء الحجز…' : payStage === 'paying' ? 'جارٍ الدفع…' : 'جارٍ…')
              : `ادفع ${nfA(stickyTotal)} ر.س`}
          </button>

          {sandboxVisible && authState === 'ready' && (
            <button
              type="button"
              className="brs-cta brs-cta-ghost"
              onClick={simulateFailureIfSandbox}
              disabled={payBusy || stickyTotal <= 0}
              data-testid="brs-pay-fail"
            >
              محاكاة فشل الدفع (sandbox)
            </button>
          )}

          {!isBackendRow && (
            <div className="brs-demo-note" role="note">
              هذا عرض تصميم للعقار التجريبي. الحجز الفعلي متاح على الإعلانات المنشورة فقط.
            </div>
          )}
        </div>
      </div>
      <style jsx global>{`
        .brs-login { margin-block-start: 12px; }
        .brs-login-head { font-size: 14px; font-weight: 700; margin-block-end: 8px; }
        .ol-field { display: grid; gap: 6px; font-size: 14px; margin-block-end: 10px; }
        .ol-field > span { color: var(--ink-2); font-size: 13px; }
        .ol-field input { padding: 12px 14px; border-radius: var(--radius); border: 1px solid var(--line); background: #fff; font-size: 15px; min-height: 44px; }
        .ol-field input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
        .ol-btn { padding: 12px 20px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--ground-2); color: var(--ink); font-family: inherit; font-size: 14px; cursor: pointer; min-height: 44px; width: 100%; }
        .ol-btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
        .ol-btn:disabled { opacity: .55; cursor: not-allowed; }
        .ol-row { display: flex; gap: 8px; } .ol-row .ol-btn { flex: 1; }
        .ol-alert { padding: 10px 12px; border-radius: var(--radius); font-size: 13px; margin-block-end: 10px; background: #f7e2dd; color: var(--danger); }
        .brs-pay-error { padding: 10px 12px; border-radius: var(--radius); font-size: 13px; margin: 10px 16px; background: #f7e2dd; color: var(--danger); }
        .brs-cta-ghost { background: #fff !important; color: var(--ink) !important; border: 1px solid var(--line) !important; margin-block-start: 6px; }
        .brs-demo-note { padding: 10px 12px; margin: 10px 16px 0; border-radius: var(--radius); font-size: 12px; color: var(--ink-2); background: var(--ground); }
      `}</style>
    </>
  );
}
