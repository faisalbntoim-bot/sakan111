'use client';

/**
 * Step 2 of the booking flow: shows the price breakdown for the dates
 * and guest count picked in step 1. Reads state from sessionStorage —
 * if the user landed here without a check-in, we bounce them back to
 * step 1 so the flow can never enter a nonsensical intermediate state.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getProperty } from '@/lib/properties';
import {
  readBooking,
  nightsBetween,
  computePrice,
  formatArabicDate,
  nfA,
  type BookingState,
} from '@/lib/booking-state';
import { BookingChrome } from '@/components/booking/BookingChrome';
import { PropertyMiniCard } from '@/components/booking/PropertyMiniCard';

export default function BookingPricePage({ params }: { params: { locale: string; id: string } }) {
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
        <BookingChrome title="تفاصيل السعر" fallbackHref={`/${params.locale}`} />
        <div className="bkp">
          <div className="bk-missing">
            <b>لم يتم العثور على هذا العقار</b>
            <a href={`/${params.locale}`}>العودة للصفحة الرئيسية</a>
          </div>
        </div>
      </>
    );
  }

  const backHref = `/${params.locale}/properties/${property.id}/booking`;

  if (!state) {
    return (
      <>
        <BookingChrome title="تفاصيل السعر" fallbackHref={backHref} />
        <div className="bkp"><div className="bk-missing">جارِ التحميل…</div></div>
      </>
    );
  }

  const nights = nightsBetween(state.checkIn, state.checkOut);
  const price = computePrice(property.dailyRate, nights, property.cleaning);

  return (
    <>
      <BookingChrome title="تفاصيل السعر" fallbackHref={backHref} />
      <main className="bkp">
        <PropertyMiniCard property={property} />

        <section className="bks">
          <h2 className="bks-title">الإقامة</h2>
          <div className="bk-info">
            <div className="bk-info-row">
              <span className="bk-k">تاريخ الوصول</span>
              <span className="bk-v">{formatArabicDate(state.checkIn)}</span>
            </div>
            <div className="bk-info-row">
              <span className="bk-k">تاريخ المغادرة</span>
              <span className="bk-v">{formatArabicDate(state.checkOut)}</span>
            </div>
            <div className="bk-info-row">
              <span className="bk-k">عدد الليالي</span>
              <span className="bk-v">{nfA(nights)}</span>
            </div>
            <div className="bk-info-row">
              <span className="bk-k">الضيوف</span>
              <span className="bk-v">
                {nfA(state.adults)} بالغ{state.children > 0 ? ` · ${nfA(state.children)} طفل` : ''}
              </span>
            </div>
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
      </main>

      <div className="bk-sticky">
        <div className="bk-sticky-inner">
          <div className="bk-sticky-tx">
            <b>{nfA(price.total)} ر.س</b>
            <small>الإجمالي شامل الرسوم والضريبة</small>
          </div>
          <button
            className="bk-cta"
            onClick={() => router.push(`/${params.locale}/properties/${property.id}/booking/review`)}
          >
            مراجعة الحجز
          </button>
        </div>
      </div>
    </>
  );
}
