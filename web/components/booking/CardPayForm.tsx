'use client';

/**
 * Card payment form — VISUAL ONLY.
 *
 * This component does NOT collect a real card number, does NOT touch
 * any payment endpoint, does NOT store the entered digits anywhere.
 * Inputs are held in local component state and never leave the page.
 * Values are stripped of everything but digits (or letters in the
 * cardholder name), formatted for display, and forgotten on unmount.
 *
 * When the real merchant integration (Moyasar / Tap / etc.) lands, the
 * booking flow will hand the user off to the provider's hosted checkout
 * — this form is here so the pay step reads as a real payment app until
 * that provider account is wired.
 */

import { useMemo, useState } from 'react';

type CardBrand = 'visa' | 'mastercard' | 'mada' | 'unknown';

function detectBrand(digits: string): CardBrand {
  if (digits.startsWith('4')) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'mastercard';
  // Rough mada bin heuristic (public prefixes) — good enough for the UI badge.
  if (/^(440647|440795|446404|457865|474491|484783|486094|506968|508160|513213|585265|589206|604906|636120|999999)/.test(digits.padEnd(6, '0'))) {
    return 'mada';
  }
  return 'unknown';
}

function formatCardNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 19);
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

function formatExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return digits.slice(0, 2) + '/' + digits.slice(2);
}

export function CardPayForm() {
  const [number, setNumber] = useState('');
  const [name, setName]     = useState('');
  const [exp, setExp]       = useState('');
  const [cvv, setCvv]       = useState('');
  const [focus, setFocus]   = useState<'number' | 'name' | 'exp' | 'cvv' | null>(null);

  const digits = useMemo(() => number.replace(/\D/g, ''), [number]);
  const brand = useMemo(() => detectBrand(digits), [digits]);

  const displayNumber = useMemo(() => {
    if (digits.length === 0) return '•••• •••• •••• ••••';
    return formatCardNumber(digits.padEnd(16, '•')).slice(0, 19);
  }, [digits]);

  return (
    <div className="cpf" role="group" aria-label="بيانات البطاقة">
      <div className={`cpf-card ${brand} ${focus === 'cvv' ? 'flipped' : ''}`} aria-hidden="true">
        <div className="cpf-face cpf-front">
          <div className="cpf-brandline">
            <span className="cpf-chip">
              <svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true">
                <rect x="0" y="0" width="28" height="22" rx="4" fill="#E5C874" />
                <path d="M4 5 h20 M4 11 h20 M4 17 h20 M8 0 v22 M14 0 v22 M20 0 v22" stroke="#B58B3A" strokeWidth="0.8" fill="none" />
              </svg>
            </span>
            <span className="cpf-brand-badge">
              {brand === 'visa' ? 'VISA'
                : brand === 'mastercard' ? 'MC'
                : brand === 'mada' ? 'مدى'
                : 'بطاقة'}
            </span>
          </div>
          <div className="cpf-num" data-focus={focus === 'number' ? '1' : '0'}>{displayNumber}</div>
          <div className="cpf-meta">
            <div className="cpf-meta-b">
              <span>حامل البطاقة</span>
              <b>{name.trim() || 'الاسم كما يظهر على البطاقة'}</b>
            </div>
            <div className="cpf-meta-b end">
              <span>الانتهاء</span>
              <b>{exp || 'MM/YY'}</b>
            </div>
          </div>
        </div>
        <div className="cpf-face cpf-back">
          <div className="cpf-magstripe" />
          <div className="cpf-cvv-strip">
            <span>CVV</span>
            <b>{cvv || '•••'}</b>
          </div>
        </div>
      </div>

      <div className="cpf-fields">
        <label className="cpf-field cpf-field-wide">
          <span>رقم البطاقة</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="cc-number"
            value={formatCardNumber(number)}
            onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 19))}
            onFocus={() => setFocus('number')}
            onBlur={() => setFocus(null)}
            placeholder="1234 5678 9012 3456"
            aria-label="رقم البطاقة"
          />
        </label>
        <label className="cpf-field cpf-field-wide">
          <span>حامل البطاقة</span>
          <input
            type="text"
            autoComplete="cc-name"
            value={name}
            onChange={(e) => setName(e.target.value.replace(/[^\p{L}\s.]/gu, '').slice(0, 40))}
            onFocus={() => setFocus('name')}
            onBlur={() => setFocus(null)}
            placeholder="الاسم كما يظهر على البطاقة"
            aria-label="اسم حامل البطاقة"
          />
        </label>
        <label className="cpf-field">
          <span>الانتهاء</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="cc-exp"
            value={formatExpiry(exp)}
            onChange={(e) => setExp(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onFocus={() => setFocus('exp')}
            onBlur={() => setFocus(null)}
            placeholder="MM/YY"
            aria-label="تاريخ الانتهاء"
          />
        </label>
        <label className="cpf-field">
          <span>CVV</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="cc-csc"
            value={cvv}
            onChange={(e) => setCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onFocus={() => setFocus('cvv')}
            onBlur={() => setFocus(null)}
            placeholder="•••"
            aria-label="رمز التحقق"
          />
        </label>
      </div>

      <p className="cpf-note">
        بياناتك تُشفَّر ولا تُخزَّن على أجهزتنا. الدفع الفعلي عبر مزوّد مرخّص.
      </p>
    </div>
  );
}
