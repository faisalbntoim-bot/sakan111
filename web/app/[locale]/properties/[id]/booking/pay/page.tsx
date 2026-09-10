'use client';

/**
 * Payment step — SakanHub-native, one screen.
 *
 * Rewritten from the previous "Apple Pay-first" design to fit the app
 * identity: green primary CTA that always says "ادفع XXX ر.س", method
 * chips (mada / Apple Pay / Visa / STC Pay) that only change the label
 * on the CTA. The proprietary Apple Pay black pill only appears if the
 * user actually taps the Apple Pay method — Apple's brand-guideline
 * placement, not a default that visually dominates the page.
 *
 * We do NOT wire a real payment provider here — real integration needs
 * a merchant identifier + domain-verified endpoint, which a preview
 * cannot honestly produce. Tapping pay opens an honest "قيد التفعيل"
 * confirmation instead of pretending money moved.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getProperty } from '@/lib/properties';
import {
  readBooking,
  nightsBetween,
  computePrice,
  formatArabicDayDate,
  addMonths,
  nfA,
  type BookingState,
} from '@/lib/booking-state';
import { BookingChrome } from '@/components/booking/BookingChrome';
import { PropertyMiniCard } from '@/components/booking/PropertyMiniCard';

type Method = 'mada' | 'apple' | 'card' | 'stc';

const ANNUAL_MONTHLY_FROM_DAILY = 30 * 0.55;
const VAT_RATE = 0.15;
const SERVICE_FEE_RATE_ANNUAL = 0.05;

export default function BookingPayPage({ params }: { params: { locale: string; id: string } }) {
  const router = useRouter();
  const property = getProperty(params.id);
  const [state, setState] = useState<BookingState | null>(null);
  const [method, setMethod] = useState<Method>('mada');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = readBooking(params.id);
    if (!s.checkIn || (s.mode === 'daily' && !s.checkOut)) {
      router.replace(`/${params.locale}/properties/${params.id}/booking?mode=${s.mode}`);
      return;
    }
    setState(s);
  }, [params.id, params.locale, router]);

  if (!property) {
    return (
      <>
        <BookingChrome title="الدفع" fallbackHref={`/${params.locale}`} />
        <div className="bkp"><div className="bk-missing"><b>لم يتم العثور على هذا العقار</b><a href={`/${params.locale}`}>العودة للصفحة الرئيسية</a></div></div>
      </>
    );
  }
  const backHref = `/${params.locale}/properties/${property.id}/booking?mode=${state?.mode ?? 'daily'}`;
  if (!state) {
    return (
      <>
        <BookingChrome title="الدفع" fallbackHref={backHref} />
        <div className="bkp"><div className="bk-missing">جارِ التحميل…</div></div>
      </>
    );
  }

  const isAnnual = state.mode === 'annual';
  const nights = nightsBetween(state.checkIn, state.checkOut);
  let total = 0;
  let subLine = '';
  if (isAnnual && state.checkIn) {
    const monthlyRate = Math.round(property.dailyRate * ANNUAL_MONTHLY_FROM_DAILY);
    const subtotal = monthlyRate * state.months;
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE_ANNUAL);
    const vat = Math.round((subtotal + serviceFee) * VAT_RATE);
    total = subtotal + serviceFee + vat;
    subLine = `${formatArabicDayDate(state.checkIn)} → ${formatArabicDayDate(addMonths(state.checkIn, state.months))} · ${nfA(state.months)} شهرًا`;
  } else if (!isAnnual && nights > 0) {
    const price = computePrice(property.dailyRate, nights, property.cleaning);
    total = price.total;
    subLine = `${formatArabicDayDate(state.checkIn)} → ${formatArabicDayDate(state.checkOut)} · ${nfA(nights)} ليالٍ`;
  }

  const guestsSummary = (() => {
    const parts: string[] = [`${nfA(state.adults)} بالغ`];
    if (state.children > 0) parts.push(`${nfA(state.children)} طفل`);
    if (state.infants > 0) parts.push(`${nfA(state.infants)} رضيع`);
    return parts.join(' · ');
  })();

  const pay = () => {
    setBusy(true);
    // Honest stub: brief pause to show the CTA reacting, then a clear
    // "provider integration pending" message. No fake success screen.
    setTimeout(() => {
      setBusy(false);
      alert('بوابة الدفع الفعلية عبر مزوّد مرخّص قيد التفعيل. لن يتم خصم أي مبلغ.');
    }, 550);
  };

  return (
    <>
      <BookingChrome title="الدفع" fallbackHref={backHref} />
      <main className="bkp">
        {/* Compact summary — property + dates + guests + total in one card. */}
        <div className="pay-summary-v3">
          <div className="pay-sv3-head">
            <PropertyMiniCard property={property} />
          </div>
          <div className="pay-sv3-lines">
            <div className="pay-sv3-line"><span>{isAnnual ? 'مدة العقد' : 'الإقامة'}</span><b>{subLine || '—'}</b></div>
            <div className="pay-sv3-line"><span>الضيوف</span><b>{guestsSummary}</b></div>
            <div className="pay-sv3-line total"><span>الإجمالي</span><b>{nfA(total)} <small>ر.س</small></b></div>
          </div>
        </div>

        {/* Method picker — chip row, not stacked cards; keeps the page short. */}
        <div className="pay-methods-v3" role="radiogroup" aria-label="طريقة الدفع">
          {(
            [
              { k: 'mada' as const,  label: 'مدى',       hint: 'الشبكة السعودية' },
              { k: 'apple' as const, label: 'Apple Pay',  hint: 'Face ID / Touch ID' },
              { k: 'card' as const,  label: 'بطاقة',      hint: 'Visa · Mastercard' },
              { k: 'stc' as const,   label: 'STC Pay',    hint: 'محفظة رقمية' },
            ]
          ).map((m) => (
            <button
              key={m.k}
              type="button"
              role="radio"
              aria-checked={method === m.k}
              className={`pm-v3 ${method === m.k ? 'on' : ''}`}
              onClick={() => setMethod(m.k)}
            >
              <span className={`pm-v3-ic pm-v3-${m.k}`} aria-hidden="true">
                {m.k === 'apple' && <ApplePayGlyph size={14} />}
                {m.k === 'mada' && <span className="pm-v3-mada-lbl">مدى</span>}
                {m.k === 'card' && <CardIcon size={16} />}
                {m.k === 'stc' && <span className="pm-v3-stc-lbl">STC</span>}
              </span>
              <span className="pm-v3-tx"><b>{m.label}</b><small>{m.hint}</small></span>
            </button>
          ))}
        </div>

        {/* Secure line — same visual weight as SPA fine-print. */}
        <div className="pay-secure-v3">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/>
            <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>
          </svg>
          <span>مبلغك محتجز بأمان في ضمان سكن هوب ولا يُحوّل للمالك إلا بعد استلامك العقار.</span>
        </div>
      </main>

      {/* Sticky CTA — SakanHub green primary, or Apple Pay black pill ONLY
          when Apple Pay is explicitly the selected method (per brand
          guidelines). */}
      <div className="bk-sticky">
        <div className="bk-sticky-inner" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          {method === 'apple' ? (
            <button className="pay-cta-ap-v3" onClick={pay} disabled={busy}>
              <span>ادفع بـ</span>
              <span className="ap-mark"><span className="ap-glyph"><ApplePayGlyph size={20} /></span><span>Pay</span></span>
              <span className="ap-amt">· {nfA(total)} ر.س</span>
            </button>
          ) : (
            <button className="bk-cta pay-cta-primary" onClick={pay} disabled={busy || total <= 0}>
              {busy ? 'جارٍ التحقق…' : `ادفع ${nfA(total)} ر.س`}
            </button>
          )}
          <div className="pay-tos-v3">
            بضغطك على زر الدفع فأنت توافق على شروط الحجز وسياسة الإلغاء.
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

function CardIcon({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/>
      <path d="M2.5 10h19M6 15h4"/>
    </svg>
  );
}
