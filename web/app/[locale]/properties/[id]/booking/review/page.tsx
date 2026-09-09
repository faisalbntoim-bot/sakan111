'use client';

/**
 * Step 3: final review. Shows check-in / check-out / guests / price
 * one more time in the layout the mockup calls for, then hands the
 * user to the payment stage. We do NOT invent a payment gateway
 * here — the CTA links to /[locale]/properties/[id]/booking/pay
 * (a placeholder route stub) so Moyasar wiring can land later
 * without changing this page.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getProperty } from '@/lib/properties';
import {
  readBooking,
  nightsBetween,
  computePrice,
  formatArabicDayDate,
  nfA,
  type BookingState,
} from '@/lib/booking-state';
import { BookingChrome } from '@/components/booking/BookingChrome';
import { PropertyMiniCard } from '@/components/booking/PropertyMiniCard';

export default function BookingReviewPage({ params }: { params: { locale: string; id: string } }) {
  const router = useRouter();
  const property = getProperty(params.id);
  const [state, setState] = useState<BookingState | null>(null);

  useEffect(() => {
    const s = readBooking(params.id);
    if (!s.checkIn || !s.checkOut) {
      router.replace(`/${params.locale}/properties/${params.id}/booking`);
      return;
    }
    setState(s);
  }, [params.id, params.locale, router]);

  if (!property) {
    return (
      <>
        <BookingChrome title="مراجعة الحجز" fallbackHref={`/${params.locale}`} />
        <div className="bkp">
          <div className="bk-missing">
            <b>لم يتم العثور على هذا العقار</b>
            <a href={`/${params.locale}`}>العودة للصفحة الرئيسية</a>
          </div>
        </div>
      </>
    );
  }

  const backHref = `/${params.locale}/properties/${property.id}/booking/price`;

  if (!state) {
    return (
      <>
        <BookingChrome title="مراجعة الحجز" fallbackHref={backHref} />
        <div className="bkp"><div className="bk-missing">جارِ التحميل…</div></div>
      </>
    );
  }

  const nights = nightsBetween(state.checkIn, state.checkOut);
  const price = computePrice(property.dailyRate, nights, property.cleaning);

  return (
    <>
      <BookingChrome title="مراجعة الحجز" fallbackHref={backHref} />
      <main className="bkp">
        <PropertyMiniCard property={property} />

        <section className="bks">
          <h2 className="bks-title">تسجيل الوصول والمغادرة</h2>
          <div className="bk-info">
            <div className="bk-info-row">
              <span className="bk-k">تسجيل الوصول</span>
              <span className="bk-v">
                {formatArabicDayDate(state.checkIn)}
                <small>الساعة ٣:٠٠ عصرًا</small>
              </span>
            </div>
            <div className="bk-info-row">
              <span className="bk-k">تسجيل المغادرة</span>
              <span className="bk-v">
                {formatArabicDayDate(state.checkOut)}
                <small>الساعة ١٢:٠٠ ظهرًا</small>
              </span>
            </div>
          </div>
        </section>

        <section className="bks">
          <h2 className="bks-title">الضيوف</h2>
          <div className="bk-info">
            <div className="bk-info-row">
              <span className="bk-k">البالغون</span>
              <span className="bk-v">{nfA(state.adults)}</span>
            </div>
            {state.children > 0 && (
              <div className="bk-info-row">
                <span className="bk-k">الأطفال</span>
                <span className="bk-v">{nfA(state.children)}</span>
              </div>
            )}
          </div>
        </section>

        <section className="bks">
          <h2 className="bks-title">تفاصيل السعر</h2>
          <div className="bk-price">
            <div className="pr-row">
              <span>{nfA(nights)} ليالٍ × {nfA(property.dailyRate)} ر.س</span>
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
        </section>

        <button
          type="button"
          className="bk-coupon"
          onClick={() => alert('سيتم دعم رموز الخصم في المرحلة القادمة.')}
        >
          <span>إضافة رمز خصم</span>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
      </main>

      <div className="bk-sticky">
        <div className="bk-sticky-inner">
          <div className="bk-sticky-tx">
            <b>{nfA(price.total)} ر.س</b>
            <small>الإجمالي شامل الرسوم والضريبة</small>
          </div>
          <button
            className="bk-cta"
            onClick={() => router.push(`/${params.locale}/properties/${property.id}/booking/pay`)}
          >
            المتابعة إلى الدفع
          </button>
        </div>
      </div>
    </>
  );
}
