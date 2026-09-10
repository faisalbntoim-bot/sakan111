'use client';

/**
 * Booking flow — single scrollable page.
 *
 * All previous separate pages (dates, price, review) are consolidated
 * here per the current spec. Layout, top-down:
 *   1. Property mini card
 *   2. Dates — calendar + live "arrival / departure / N nights" summary
 *   3. Guests — adults / children / infants (compact)
 *   4. Price breakdown (updates instantly on any change)
 *   5. Booking info (check-in/out times, cancellation, house rules)
 *   6. Sticky bottom bar with total + "مراجعة وتأكيد الحجز"
 *      → opens a review bottom-sheet inside the same page
 *      → its CTA goes to /pay (existing payment page)
 *
 * State is persisted per-property in sessionStorage so back-nav
 * preserves choices. The two legacy routes (/price, /review) now
 * redirect here to avoid dead pages.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getProperty } from '@/lib/properties';
import {
  readBooking,
  writeBooking,
  nightsBetween,
  computePrice,
  formatArabicDate,
  formatArabicDayDate,
  nfA,
  type BookingState,
} from '@/lib/booking-state';
import { BookingChrome } from '@/components/booking/BookingChrome';
import { PropertyMiniCard } from '@/components/booking/PropertyMiniCard';
import { RtlCalendar } from '@/components/booking/RtlCalendar';
import { GuestsPicker } from '@/components/booking/GuestsPicker';

export default function BookingPage({ params }: { params: { locale: string; id: string } }) {
  const router = useRouter();
  const property = getProperty(params.id);

  const [state, setState] = useState<BookingState>(() => ({
    propertyId: params.id,
    checkIn: null,
    checkOut: null,
    adults: 1,
    children: 0,
    infants: 0,
  }));
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    setState(readBooking(params.id));
  }, [params.id]);

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
  const price = useMemo(
    () => property ? computePrice(property.dailyRate, nights, property.cleaning) : null,
    [property, nights],
  );

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

  const canBook = nights > 0 && state.adults >= 1;

  const onDatesChange = (checkIn: string | null, checkOut: string | null) =>
    setState(prev => ({ ...prev, checkIn, checkOut }));
  const onGuestsChange = (next: { adults: number; children: number; infants: number }) =>
    setState(prev => ({ ...prev, ...next }));

  const guestsSummary = (() => {
    const parts: string[] = [`${nfA(state.adults)} بالغ`];
    if (state.children > 0) parts.push(`${nfA(state.children)} طفل`);
    if (state.infants > 0) parts.push(`${nfA(state.infants)} رضيع`);
    return parts.join(' · ');
  })();

  return (
    <>
      <BookingChrome title="إكمال الحجز" fallbackHref={`/${params.locale}`} />

      <main className="bkp">
        {/* 1) Property mini-card */}
        <PropertyMiniCard property={property} />
        <div className="bkc-price-strip">
          <div>سعر الليلة</div>
          <b>{nfA(property.dailyRate)} <small>ر.س</small></b>
        </div>

        {/* 2) Dates */}
        <section className="bks">
          <h2 className="bks-title">اختر التواريخ</h2>
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
        </section>

        {/* 3) Guests */}
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

        {/* 4) Price breakdown */}
        <section className="bks">
          <h2 className="bks-title">تفاصيل السعر</h2>
          {price && nights > 0 ? (
            <div className="bk-price">
              <div className="pr-row">
                <span>{nfA(property.dailyRate)} ر.س × {nfA(nights)} ليالٍ</span>
                <span>{nfA(price.subtotal)} ر.س</span>
              </div>
              {property.cleaning > 0 && (
                <div className="pr-row">
                  <span>رسوم التنظيف</span>
                  <span>{nfA(price.cleaning)} ر.س</span>
                </div>
              )}
              <div className="pr-row">
                <span>رسوم خدمة سكن هوب</span>
                <span>{nfA(price.serviceFee)} ر.س</span>
              </div>
              <div className="pr-row">
                <span>ضريبة القيمة المضافة</span>
                <span>{nfA(price.vat)} ر.س</span>
              </div>
              <div className="pr-row total">
                <span>الإجمالي</span>
                <span className="pr-v">{nfA(price.total)} ر.س</span>
              </div>
            </div>
          ) : (
            <p className="bks-sub">حدّد التواريخ لعرض السعر الإجمالي فورًا هنا.</p>
          )}
        </section>

        {/* 5) Booking info */}
        <section className="bks">
          <h2 className="bks-title">معلومات الحجز</h2>
          <ul className="bk-info-list">
            <li><span className="ic" aria-hidden="true">🕒</span><div><b>تسجيل الوصول</b><small>الساعة ٣:٠٠ عصرًا</small></div></li>
            <li><span className="ic" aria-hidden="true">🕚</span><div><b>تسجيل المغادرة</b><small>الساعة ١١:٠٠ صباحًا</small></div></li>
            <li><span className="ic" aria-hidden="true">↩️</span><div><b>سياسة الإلغاء</b><small>إلغاء مجاني قبل ٤٨ ساعة من الوصول</small></div></li>
            <li><span className="ic" aria-hidden="true">🏠</span><div><b>قواعد العقار</b><small>ممنوع التدخين · هدوء بعد الساعة ١١ ليلًا</small></div></li>
          </ul>
        </section>
      </main>

      {/* 6) Sticky bottom bar */}
      <div className="bk-sticky">
        <div className="bk-sticky-inner">
          <div className="bk-sticky-tx">
            {price && nights > 0 ? (
              <>
                <b>{nfA(price.total)} <small>ر.س</small></b>
                <small>{nfA(nights)} ليالٍ · شامل الرسوم</small>
              </>
            ) : (
              <>
                <b>حدّد التواريخ للمتابعة</b>
                <small>سعر الليلة {nfA(property.dailyRate)} ر.س</small>
              </>
            )}
          </div>
          <button
            className="bk-cta"
            disabled={!canBook}
            onClick={() => setReviewOpen(true)}
          >
            مراجعة وتأكيد الحجز
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
              <div className="brs-row">
                <span className="brs-k">الوصول</span>
                <span className="brs-v">{formatArabicDayDate(state.checkIn)}</span>
              </div>
              <div className="brs-row">
                <span className="brs-k">المغادرة</span>
                <span className="brs-v">{formatArabicDayDate(state.checkOut)}</span>
              </div>
              <div className="brs-row">
                <span className="brs-k">عدد الليالي</span>
                <span className="brs-v">{nfA(nights)}</span>
              </div>
              <div className="brs-row">
                <span className="brs-k">الضيوف</span>
                <span className="brs-v">{guestsSummary}</span>
              </div>
              {price && (
                <div className="brs-row total">
                  <span className="brs-k">الإجمالي</span>
                  <span className="brs-v">{nfA(price.total)} ر.س</span>
                </div>
              )}
            </div>
          </div>
          <button
            className="brs-cta"
            onClick={() => router.push(`/${params.locale}/properties/${property.id}/booking/pay`)}
          >
            المتابعة إلى الدفع
          </button>
        </div>
      </div>
    </>
  );
}
