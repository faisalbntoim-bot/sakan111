'use client';

/**
 * Booking flow — single scrollable page, daily + annual in one shell.
 *
 * The rental mode arrives as `?mode=daily|annual` from the SPA button.
 * Both modes share the same layout tokens (property card, guests picker,
 * price breakdown, review bottom-sheet) so switching is a visual
 * micro-change, not a different app:
 *
 *   * daily  → RTL calendar (arrival + departure), price = nights × rate
 *              + cleaning + service fee + VAT.
 *   * annual → contract start date + duration chips (12 / 24 / 36 months),
 *              price = monthly rate × months + service fee + VAT.
 *
 * State is persisted per-property in sessionStorage. Total updates
 * instantly on every field change (React `useMemo`); no "next" button
 * is required to see the price.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getProperty } from '@/lib/properties';
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

// Annual rent price model — daily rate × ~30 nights of the year is a poor
// proxy for a monthly rent, so we derive the monthly rate from the SPA's
// canonical `dailyRate × 30 × 0.55` ratio (long-let discount vs nightly).
// This keeps the annual and daily numbers internally consistent without
// inventing a separate `monthlyRate` field.
const ANNUAL_MONTHLY_FROM_DAILY = 30 * 0.55;
const VAT_RATE = 0.15;
const SERVICE_FEE_RATE = 0.05; // long-let service fee is lower than daily's 12%

const MONTH_CHOICES = [12, 24, 36] as const;

export default function BookingPage({ params }: { params: { locale: string; id: string } }) {
  const router = useRouter();
  const search = useSearchParams();
  const mode: BookingMode = search.get('mode') === 'annual' ? 'annual' : 'daily';
  const property = getProperty(params.id);

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
  // Payment method + inline-pay lives in the review Bottom Sheet so the
  // whole flow stays on this one route — no /pay redirect.
  const [payMethod, setPayMethod] = useState<'mada'|'apple'|'card'|'stc'>('mada');
  const [payBusy, setPayBusy] = useState(false);

  useEffect(() => {
    setState(readBooking(params.id, mode));
  }, [params.id, mode]);

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

  // Daily price — reuses the shared computePrice helper.
  const nights = nightsBetween(state.checkIn, state.checkOut);
  const dailyPrice = useMemo(
    () => property ? computePrice(property.dailyRate, nights, property.cleaning) : null,
    [property, nights],
  );

  // Annual price — inline (different rate model, no cleaning fee).
  const annualPrice = useMemo(() => {
    if (!property || mode !== 'annual') return null;
    const monthlyRate = Math.round(property.dailyRate * ANNUAL_MONTHLY_FROM_DAILY);
    const subtotal = monthlyRate * state.months;
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE);
    const vat = Math.round((subtotal + serviceFee) * VAT_RATE);
    const total = subtotal + serviceFee + vat;
    return { monthlyRate, subtotal, serviceFee, vat, total };
  }, [property, mode, state.months]);

  if (!property) {
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

  const isAnnual = mode === 'annual';
  const canBook = isAnnual
    ? !!state.checkIn && state.months > 0 && state.adults >= 1
    : nights > 0 && state.adults >= 1;

  const onDatesChange = (checkIn: string | null, checkOut: string | null) =>
    setState(prev => ({ ...prev, checkIn, checkOut }));
  const onAnnualStart = (checkIn: string | null) =>
    setState(prev => ({ ...prev, checkIn }));
  const onMonths = (m: number) =>
    setState(prev => ({ ...prev, months: m }));
  const onGuestsChange = (next: { adults: number; children: number; infants: number }) =>
    setState(prev => ({ ...prev, ...next }));

  const guestsSummary = (() => {
    const parts: string[] = [`${nfA(state.adults)} بالغ`];
    if (state.children > 0) parts.push(`${nfA(state.children)} طفل`);
    if (state.infants > 0) parts.push(`${nfA(state.infants)} رضيع`);
    return parts.join(' · ');
  })();

  const contractEnd = isAnnual && state.checkIn ? addMonths(state.checkIn, state.months) : null;
  const switchMode = (m: BookingMode) => {
    router.replace(`/${params.locale}/properties/${property.id}/booking?mode=${m}`);
  };

  const stickyTotal = isAnnual ? (annualPrice?.total ?? 0) : (dailyPrice?.total ?? 0);

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

        {/* Dates section — daily = range, annual = single start */}
        <section className="bks">
          <h2 className="bks-title">{isAnnual ? 'بداية العقد ومدته' : 'اختر التواريخ'}</h2>

          {isAnnual ? (
            <>
              {state.checkIn && (
                <div className="dates-summary">
                  <div className="ds-cell">
                    <small>بداية العقد</small>
                    <b>{formatArabicDate(state.checkIn)}</b>
                  </div>
                  <div className="ds-arrow" aria-hidden="true">←</div>
                  <div className="ds-cell">
                    <small>نهاية العقد</small>
                    <b>{formatArabicDate(contractEnd)}</b>
                  </div>
                  <div className="ds-nights">{nfA(state.months)} شهرًا</div>
                </div>
              )}
              {!state.checkIn && (
                <p className="bks-sub">اختر تاريخ بداية العقد من التقويم — بقية المدة تُحسب تلقائيًا من الأشهر.</p>
              )}
              <RtlCalendar
                bookedDays={[]}
                checkIn={state.checkIn}
                checkOut={null}
                onChange={(ci) => onAnnualStart(ci)}
              />
              <div className="bk-annual-months" role="radiogroup" aria-label="مدة العقد">
                {MONTH_CHOICES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={state.months === m}
                    className={state.months === m ? 'on' : ''}
                    onClick={() => onMonths(m)}
                  >
                    {nfA(m)} شهر
                    <small>{m === 12 ? 'سنة واحدة' : m === 24 ? 'سنتان' : 'ثلاث سنوات'}</small>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              {nights > 0 ? (
                <div className="dates-summary">
                  <div className="ds-cell">
                    <small>الوصول</small>
                    <b>{formatArabicDate(state.checkIn)}</b>
                  </div>
                  <div className="ds-arrow" aria-hidden="true">←</div>
                  <div className="ds-cell">
                    <small>المغادرة</small>
                    <b>{formatArabicDate(state.checkOut)}</b>
                  </div>
                  <div className="ds-nights">{nfA(nights)} ليالٍ</div>
                </div>
              ) : (
                <p className="bks-sub">اختر تاريخ الوصول ثم تاريخ المغادرة على التقويم.</p>
              )}
              <RtlCalendar
                bookedDays={property.booked}
                checkIn={state.checkIn}
                checkOut={state.checkOut}
                onChange={onDatesChange}
              />
            </>
          )}
        </section>

        {/* Guests */}
        <section className="bks">
          <h2 className="bks-title">الضيوف</h2>
          <GuestsPicker
            adults={state.adults}
            children={state.children}
            infants={state.infants}
            maxGuests={property.maxGuests}
            onChange={onGuestsChange}
          />
        </section>

        {/* Price breakdown — live */}
        <section className="bks">
          <h2 className="bks-title">تفاصيل السعر</h2>
          {isAnnual && annualPrice && state.checkIn ? (
            <div className="bk-price">
              <div className="pr-row">
                <span>{nfA(annualPrice.monthlyRate)} ر.س × {nfA(state.months)} شهر</span>
                <span>{nfA(annualPrice.subtotal)} ر.س</span>
              </div>
              <div className="pr-row">
                <span>رسوم خدمة سكن هوب</span>
                <span>{nfA(annualPrice.serviceFee)} ر.س</span>
              </div>
              <div className="pr-row">
                <span>ضريبة القيمة المضافة</span>
                <span>{nfA(annualPrice.vat)} ر.س</span>
              </div>
              <div className="pr-row total">
                <span>الإجمالي السنوي</span>
                <span className="pr-v">{nfA(annualPrice.total)} ر.س</span>
              </div>
            </div>
          ) : !isAnnual && dailyPrice && nights > 0 ? (
            <div className="bk-price">
              <div className="pr-row">
                <span>{nfA(property.dailyRate)} ر.س × {nfA(nights)} ليالٍ</span>
                <span>{nfA(dailyPrice.subtotal)} ر.س</span>
              </div>
              {property.cleaning > 0 && (
                <div className="pr-row">
                  <span>رسوم التنظيف</span>
                  <span>{nfA(dailyPrice.cleaning)} ر.س</span>
                </div>
              )}
              <div className="pr-row">
                <span>رسوم خدمة سكن هوب</span>
                <span>{nfA(dailyPrice.serviceFee)} ر.س</span>
              </div>
              <div className="pr-row">
                <span>ضريبة القيمة المضافة</span>
                <span>{nfA(dailyPrice.vat)} ر.س</span>
              </div>
              <div className="pr-row total">
                <span>الإجمالي</span>
                <span className="pr-v">{nfA(dailyPrice.total)} ر.س</span>
              </div>
            </div>
          ) : (
            <p className="bks-sub">
              {isAnnual ? 'اختر بداية العقد لعرض السعر الإجمالي.' : 'حدّد التواريخ لعرض السعر الإجمالي فورًا هنا.'}
            </p>
          )}
        </section>

        {/* Booking info */}
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
      </main>

      {/* Sticky bottom bar */}
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
            disabled={!canBook}
            onClick={() => setReviewOpen(true)}
          >
            تأكيد الحجز
          </button>
        </div>
      </div>

      {/* Review bottom-sheet */}
      <div
        className={`bk-review-overlay ${reviewOpen ? 'open' : ''}`}
        onClick={() => setReviewOpen(false)}
        aria-hidden={!reviewOpen}
      >
        <div className="bk-review-sheet" onClick={(e) => e.stopPropagation()}>
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
              <div className="brs-row total"><span className="brs-k">الإجمالي</span><span className="brs-v">{nfA(stickyTotal)} ر.س</span></div>
            </div>

            {/* Inline payment method picker — no separate /pay page.
                Real Moyasar / Apple Pay integration is honestly stubbed
                until the merchant identifier + hosted checkout are wired. */}
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
                    {m.k === 'apple' && (
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                        <path d="M17.2 12.3c0-1.9 1.6-2.9 1.7-2.9-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .7.9 1.4 2 2.4 1.9 1-.1 1.3-.6 2.5-.6s1.5.6 2.6.6 1.7-.9 2.3-1.8c.7-1 1-2 1-2.1 0 0-1.9-.8-2.3-2.8zM15.3 6.4c.5-.7.9-1.6.8-2.5-.8 0-1.8.5-2.4 1.2-.5.6-1 1.5-.8 2.4.9.1 1.8-.4 2.4-1.1z"/>
                      </svg>
                    )}
                    {m.k === 'mada' && <span className="pm-v3-mada-lbl">مدى</span>}
                    {m.k === 'card' && (
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                        <rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>
                      </svg>
                    )}
                    {m.k === 'stc' && <span className="pm-v3-stc-lbl">STC</span>}
                  </span>
                  <span className="pm-v3-tx"><b>{m.label}</b></span>
                </button>
              ))}
            </div>
          </div>
          <button
            className="brs-cta"
            disabled={payBusy || stickyTotal <= 0}
            onClick={() => {
              setPayBusy(true);
              setTimeout(() => {
                setPayBusy(false);
                alert('بوابة الدفع الفعلية عبر مزوّد مرخّص قيد التفعيل. لن يتم خصم أي مبلغ في هذه المرحلة.');
              }, 550);
            }}
          >
            {payBusy ? 'جارٍ التحقق…' : `ادفع ${nfA(stickyTotal)} ر.س`}
          </button>
        </div>
      </div>
    </>
  );
}
