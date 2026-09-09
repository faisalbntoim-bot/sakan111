'use client';

/**
 * Step 1 of the booking flow: pick check-in + check-out + guests.
 *
 * State is persisted per-property in sessionStorage (see lib/booking-state)
 * so backing out of any later step preserves the user's choices. Property
 * data comes from the shared PROPERTIES list — no fetch needed.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getProperty } from '@/lib/properties';
import {
  readBooking,
  writeBooking,
  nightsBetween,
  nfA,
  type BookingState,
} from '@/lib/booking-state';
import { BookingChrome } from '@/components/booking/BookingChrome';
import { RtlCalendar } from '@/components/booking/RtlCalendar';
import { GuestsPicker } from '@/components/booking/GuestsPicker';

export default function BookingDatesPage({ params }: { params: { locale: string; id: string } }) {
  const router = useRouter();
  const property = getProperty(params.id);

  // Start from the sessionStorage snapshot so back-nav preserves state.
  // We hydrate inside useEffect to avoid an SSR/CSR mismatch on the
  // sessionStorage read (server returns blank, first client render
  // matches, then the effect fills in any saved values).
  const [state, setState] = useState<BookingState>(() => ({
    propertyId: params.id,
    checkIn: null,
    checkOut: null,
    adults: 1,
    children: 0,
  }));

  useEffect(() => {
    setState(readBooking(params.id));
  }, [params.id]);

  useEffect(() => {
    writeBooking(state);
  }, [state]);

  if (!property) {
    return (
      <>
        <BookingChrome title="اختر التواريخ" fallbackHref={`/${params.locale}`} />
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

  const nights = nightsBetween(state.checkIn, state.checkOut);
  const canContinue =
    !!state.checkIn && !!state.checkOut && nights > 0 && state.adults >= 1;

  const onDatesChange = (checkIn: string | null, checkOut: string | null) => {
    setState(prev => ({ ...prev, checkIn, checkOut }));
  };
  const onGuestsChange = (next: { adults: number; children: number }) => {
    setState(prev => ({ ...prev, ...next }));
  };

  const total = nights > 0 ? nights * property.dailyRate : 0;

  return (
    <>
      <BookingChrome title="اختر التواريخ" fallbackHref={`/${params.locale}`} />
      <main className="bkp">
        <section className="bks">
          <h2 className="bks-title">التواريخ</h2>
          <p className="bks-sub">
            اختر تاريخ الوصول ثم تاريخ المغادرة. لن نسمح بتواريخ سابقة أو محجوزة.
          </p>
          <RtlCalendar
            bookedDays={property.booked}
            checkIn={state.checkIn}
            checkOut={state.checkOut}
            onChange={onDatesChange}
          />
        </section>

        <section className="bks">
          <h2 className="bks-title">عدد الضيوف</h2>
          <p className="bks-sub">من سيقيم معك خلال هذه الإقامة؟</p>
          <GuestsPicker
            adults={state.adults}
            children={state.children}
            maxGuests={property.maxGuests}
            onChange={onGuestsChange}
          />
        </section>
      </main>

      <div className="bk-sticky" role="region" aria-label="متابعة الحجز">
        <div className="bk-sticky-inner">
          <div className="bk-sticky-tx">
            {nights > 0 ? (
              <>
                <b>{nfA(total)} ر.س</b>
                <small>{nfA(nights)} ليالٍ · قبل الرسوم والضريبة</small>
              </>
            ) : (
              <>
                <b>حدّد التواريخ للمتابعة</b>
                <small>سعر الليلة: {nfA(property.dailyRate)} ر.س</small>
              </>
            )}
          </div>
          <button
            className="bk-cta"
            disabled={!canContinue}
            onClick={() => router.push(`/${params.locale}/properties/${property.id}/booking/price`)}
          >
            متابعة
          </button>
        </div>
      </div>
    </>
  );
}
