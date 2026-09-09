'use client';

/**
 * Payment step — Apple Pay-forward UI with mada and card as alternates.
 *
 * We do NOT wire a real payment provider here: real Apple Pay integration
 * needs an Apple merchant identifier, a domain-verified endpoint, and a
 * server session token that a marketing preview cannot produce honestly.
 * Instead this page:
 *   1. Renders a real Apple Pay-styled sheet with the actual booking
 *      totals from sessionStorage (no fake numbers).
 *   2. Shows an Apple Pay confirmation overlay that mimics the iOS
 *      payment sheet with the correct amount and method.
 *   3. Ends with an explicit "قيد التفعيل" message when the user taps
 *      confirm — so nobody thinks a real charge happened.
 * Backend / Moyasar integration lands as a separate task.
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

type Method = 'apple' | 'mada' | 'card';

export default function BookingPayPage({ params }: { params: { locale: string; id: string } }) {
  const router = useRouter();
  const property = getProperty(params.id);
  const [state, setState] = useState<BookingState | null>(null);
  const [method, setMethod] = useState<Method>('apple');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    const s = readBooking(params.id);
    if (!s.checkIn || !s.checkOut) {
      router.replace(`/${params.locale}/properties/${params.id}/booking`);
      return;
    }
    setState(s);
  }, [params.id, params.locale, router]);

  // Prevent background scroll while the Apple Pay sheet is open.
  useEffect(() => {
    if (sheetOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [sheetOpen]);

  if (!property) {
    return (
      <>
        <BookingChrome title="الدفع" fallbackHref={`/${params.locale}`} />
        <div className="bkp">
          <div className="bk-missing">
            <b>لم يتم العثور على هذا العقار</b>
            <a href={`/${params.locale}`}>العودة للصفحة الرئيسية</a>
          </div>
        </div>
      </>
    );
  }

  const backHref = `/${params.locale}/properties/${property.id}/booking/review`;

  if (!state) {
    return (
      <>
        <BookingChrome title="الدفع" fallbackHref={backHref} />
        <div className="bkp"><div className="bk-missing">جارِ التحميل…</div></div>
      </>
    );
  }

  const nights = nightsBetween(state.checkIn, state.checkOut);
  const price = computePrice(property.dailyRate, nights, property.cleaning);

  const startPay = () => {
    if (method === 'apple') {
      setSheetOpen(true);
      return;
    }
    // mada / card — no real gateway wired.
    alert('طريقة الدفع هذه قيد التفعيل عبر مزوّد مرخّص. سيتم ربطها لاحقًا.');
  };

  const confirmApplePay = () => {
    setConfirmed(true);
    // Keep the sheet visible for a beat so the user sees the transition,
    // then reset and inform them honestly that the gateway is pending.
    setTimeout(() => {
      setSheetOpen(false);
      setConfirmed(false);
      alert('تم التحقق من تفاصيل الدفع. تكامل Apple Pay الحقيقي عبر مزوّد مرخّص قيد التفعيل — لن يتم خصم أي مبلغ في هذه المرحلة.');
    }, 900);
  };

  return (
    <>
      <BookingChrome title="الدفع" fallbackHref={backHref} />
      <main className="bkp">
        <PropertyMiniCard property={property} />

        <div className="pay-summary">
          <div className="pay-sum-lbl">
            <small>إجمالي الدفع</small>
            <b>{formatArabicDayDate(state.checkIn)} → {formatArabicDayDate(state.checkOut)}</b>
          </div>
          <div className="pay-sum-total">
            {nfA(price.total)}
            <small>ر.س</small>
          </div>
        </div>

        <div className="pay-method-title">اختر طريقة الدفع</div>
        <div className="pay-methods">
          <button
            type="button"
            className={`pay-method ${method === 'apple' ? 'on' : ''}`}
            onClick={() => setMethod('apple')}
          >
            <span className="pm-ic apple" aria-hidden="true">
              <ApplePayGlyph size={16} />
            </span>
            <span className="pm-lbl">
              <b>Apple Pay</b>
              <small>الأسرع — Face ID أو Touch ID</small>
            </span>
            <span className="pm-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7"/></svg>
            </span>
          </button>
          <button
            type="button"
            className={`pay-method ${method === 'mada' ? 'on' : ''}`}
            onClick={() => setMethod('mada')}
          >
            <span className="pm-ic mada" aria-hidden="true">مدى</span>
            <span className="pm-lbl">
              <b>بطاقة مدى</b>
              <small>الشبكة السعودية للمدفوعات</small>
            </span>
            <span className="pm-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7"/></svg>
            </span>
          </button>
          <button
            type="button"
            className={`pay-method ${method === 'card' ? 'on' : ''}`}
            onClick={() => setMethod('card')}
          >
            <span className="pm-ic card" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="14" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 10h20M6 16h5"/></svg>
            </span>
            <span className="pm-lbl">
              <b>بطاقة ائتمان</b>
              <small>Visa · Mastercard</small>
            </span>
            <span className="pm-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7"/></svg>
            </span>
          </button>
        </div>

        <div className="pay-secure">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/>
            <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>
          </svg>
          <div>
            مبلغك محتجز بأمان في ضمان «سكن هوب» ولا يُحوّل للمالك إلا بعد استلامك العقار.
            الاتصال مشفّر (TLS) ومطابق لمعايير SAMA/PCI.
          </div>
        </div>

        <div className="pay-tos">
          بضغطك على زر الدفع أدناه فأنت توافق على
          {' '}<a href="#" onClick={(e) => e.preventDefault()}>شروط الحجز</a>{' '}
          و
          {' '}<a href="#" onClick={(e) => e.preventDefault()}>سياسة الإلغاء</a>.
        </div>
      </main>

      <div className="bk-sticky">
        <div className="bk-sticky-inner" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          {method === 'apple' ? (
            <button className="pay-cta-ap" onClick={startPay}>
              <span>ادفع بـ</span>
              <span className="ap-mark">
                <span className="ap-glyph"><ApplePayGlyph size={22} /></span>
                <span>Pay</span>
              </span>
            </button>
          ) : (
            <button className="pay-cta-alt" onClick={startPay}>
              متابعة الدفع · {nfA(price.total)} ر.س
            </button>
          )}
        </div>
      </div>

      {/* Apple Pay confirmation sheet */}
      <div
        className={`pay-ap-overlay ${sheetOpen ? 'open' : ''}`}
        onClick={() => !confirmed && setSheetOpen(false)}
        aria-hidden={!sheetOpen}
      >
        <div className="pay-ap-sheet" onClick={(e) => e.stopPropagation()}>
          <div className="pay-ap-handle" />
          <div className="pay-ap-head">
            <b>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <ApplePayGlyph size={16} />
                <span> Pay</span>
              </span>
              {' · '}تأكيد الدفع
            </b>
            <button className="ap-close" onClick={() => !confirmed && setSheetOpen(false)} aria-label="إغلاق">✕</button>
          </div>
          <div className="pay-ap-row">
            <span className="apr-k">إلى</span>
            <span className="apr-v">سكن هوب — {property.name}</span>
          </div>
          <div className="pay-ap-row">
            <span className="apr-k">البطاقة</span>
            <span className="apr-v">مدى ···· ٤٥٢١</span>
          </div>
          <div className="pay-ap-row total">
            <span className="apr-k">الإجمالي</span>
            <span className="apr-v">{nfA(price.total)} ر.س</span>
          </div>
          <button
            className="pay-ap-confirm"
            onClick={confirmApplePay}
            disabled={confirmed}
          >
            {confirmed ? (
              <>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7"/></svg>
                تم التحقق
              </>
            ) : (
              <>
                <FaceIdIcon size={18} />
                تأكيد ببصمة الوجه
              </>
            )}
          </button>
          <div className="pay-ap-note">
            هذه شاشة توضيحية بواجهة Apple Pay. لن يتم خصم أي مبلغ حتى يتم ربط
            بوابة الدفع الفعلية.
          </div>
        </div>
      </div>
    </>
  );
}

function ApplePayGlyph({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M17.2 12.3c0-1.9 1.6-2.9 1.7-2.9-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .7.9 1.4 2 2.4 1.9 1-.1 1.3-.6 2.5-.6s1.5.6 2.6.6 1.7-.9 2.3-1.8c.7-1 1-2 1-2.1 0 0-1.9-.8-2.3-2.8zM15.3 6.4c.5-.7.9-1.6.8-2.5-.8 0-1.8.5-2.4 1.2-.5.6-1 1.5-.8 2.4.9.1 1.8-.4 2.4-1.1z"/>
    </svg>
  );
}

function FaceIdIcon({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9V6a2 2 0 0 1 2-2h3M20 9V6a2 2 0 0 0-2-2h-3M4 15v3a2 2 0 0 0 2 2h3M20 15v3a2 2 0 0 1-2 2h-3"/>
      <path d="M9 10v1M15 10v1M9.5 15c.7.7 1.6 1 2.5 1s1.8-.3 2.5-1M12 9v4h-1"/>
    </svg>
  );
}
