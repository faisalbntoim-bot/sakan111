'use client';

/**
 * Owner login — real OTP → JWT flow using the existing Sakan Hub
 * backend endpoints (POST /v1/auth/otp, POST /v1/auth/otp/verify).
 *
 * Notes:
 *   - The access token is stored in sessionStorage under `sh_owner_token`
 *     by the authoring API client. It is NEVER rendered in the DOM.
 *   - The phone field feeds a 6-digit code step; the code is delivered
 *     by whatever the backend's `sendOtpSms` is wired to. This page
 *     does NOT integrate an SMS provider — it just calls the existing
 *     backend endpoints (backend already logs the code in dev).
 *   - On success we redirect to `?next=<safe-path>` if present and
 *     same-origin, else to `/[locale]/owner/properties`.
 *   - No development bypass. No token paste UI. No secrets logged.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  AuthoringApiError,
  fetchOwnerMe,
  requestOwnerOtp,
  verifyOwnerOtp,
} from '@/lib/property-authoring';

const PHONE_RX = /^\+?[0-9]{8,15}$/;
const CODE_RX = /^[0-9]{6}$/;

/** Only accept `next` values that stay within this app (starts with `/`, no scheme). */
function safeNextPath(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  return raw;
}

export default function OwnerLoginPage({ params }: { params: { locale: string } }) {
  // Suspense boundary is required around useSearchParams() so Next.js
  // can prerender the shell without waiting for CSR-only search state.
  return (
    <Suspense fallback={<OwnerLoginShell params={params} />}>
      <OwnerLoginInner params={params} />
    </Suspense>
  );
}

function OwnerLoginShell({ params: _params }: { params: { locale: string } }) {
  return (
    <>
      <OwnerLoginStyles />
      <main className="ol-page" dir="rtl">
        <div className="ol-card" role="status">جارٍ التحميل…</div>
      </main>
    </>
  );
}

function OwnerLoginInner({ params }: { params: { locale: string } }) {
  const router = useRouter();
  const search = useSearchParams();
  const nextPath = useMemo(
    () => safeNextPath(search?.get('next') ?? null, `/${params.locale}/owner/properties`),
    [search, params.locale],
  );

  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorAr, setErrorAr] = useState<string | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  // If a session is already valid, skip login entirely.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await fetchOwnerMe();
        if (alive) router.replace(nextPath);
      } catch { /* not signed in — stay on this page */ }
      finally { if (alive) setCheckingSession(false); }
    })();
    return () => { alive = false; };
  }, [router, nextPath]);

  const requestCode = useCallback(async () => {
    setErrorAr(null);
    const trimmed = phone.trim();
    if (!PHONE_RX.test(trimmed)) {
      setErrorAr('الرجاء إدخال رقم جوال صحيح بالصيغة الدولية (مثال: +9665XXXXXXXX).');
      return;
    }
    setBusy(true);
    try {
      const r = await requestOwnerOtp(trimmed);
      setRequestId(r.requestId);
      setStep('code');
    } catch (e) {
      setErrorAr(e instanceof AuthoringApiError ? e.message : 'تعذّر طلب رمز التحقق.');
    } finally { setBusy(false); }
  }, [phone]);

  const verifyCode = useCallback(async () => {
    setErrorAr(null);
    if (!requestId) { setErrorAr('يرجى إعادة طلب الرمز.'); setStep('phone'); return; }
    if (!CODE_RX.test(code.trim())) {
      setErrorAr('الرمز يجب أن يكون 6 أرقام.');
      return;
    }
    setBusy(true);
    try {
      await verifyOwnerOtp({
        requestId,
        phone: phone.trim(),
        code: code.trim(),
        nameAr: nameAr.trim() || undefined,
      });
      // Token is now in sessionStorage — off to the destination.
      router.replace(nextPath);
    } catch (e) {
      setErrorAr(e instanceof AuthoringApiError ? e.message : 'تعذّر التحقق من الرمز.');
    } finally { setBusy(false); }
  }, [requestId, phone, code, nameAr, router, nextPath]);

  if (checkingSession) {
    return (
      <>
        <OwnerLoginStyles />
        <main className="ol-page" dir="rtl">
          <div className="ol-card" role="status">جارٍ التحقّق من الجلسة…</div>
        </main>
      </>
    );
  }

  return (
    <>
      <OwnerLoginStyles />
      <main className="ol-page" dir="rtl">
        <section className="ol-card" aria-labelledby="ol-title">
          <h1 id="ol-title">تسجيل الدخول</h1>
          <p className="ol-muted">
            الدخول عبر رمز يُرسل إلى جوالك المسجّل لدى ساكن هَب.
          </p>

          {step === 'phone' && (
            <form
              onSubmit={(e) => { e.preventDefault(); void requestCode(); }}
              noValidate
            >
              <label className="ol-field">
                <span>رقم الجوال</span>
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+9665XXXXXXXX"
                  disabled={busy}
                  aria-invalid={!!errorAr}
                  aria-describedby={errorAr ? 'ol-error' : undefined}
                />
              </label>
              <label className="ol-field">
                <span>الاسم (اختياري لأول تسجيل)</span>
                <input
                  type="text"
                  autoComplete="name"
                  value={nameAr}
                  onChange={(e) => setNameAr(e.target.value)}
                  placeholder="مثال: فهد العبدالله"
                  disabled={busy}
                />
              </label>
              {errorAr ? <div id="ol-error" role="alert" className="ol-alert">{errorAr}</div> : null}
              <button type="submit" className="ol-btn ol-btn-primary" disabled={busy}>
                {busy ? 'جارٍ الإرسال…' : 'أرسل رمز التحقق'}
              </button>
            </form>
          )}

          {step === 'code' && (
            <form
              onSubmit={(e) => { e.preventDefault(); void verifyCode(); }}
              noValidate
            >
              <p className="ol-muted">
                أرسلنا رمزًا إلى <b>{phone}</b>. أدخل الأرقام الستة لإكمال الدخول.
              </p>
              <label className="ol-field">
                <span>رمز التحقق</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  disabled={busy}
                  aria-invalid={!!errorAr}
                  aria-describedby={errorAr ? 'ol-error' : undefined}
                />
              </label>
              {errorAr ? <div id="ol-error" role="alert" className="ol-alert">{errorAr}</div> : null}
              <div className="ol-row">
                <button type="button" className="ol-btn" onClick={() => { setStep('phone'); setCode(''); setErrorAr(null); }} disabled={busy}>
                  رجوع
                </button>
                <button type="submit" className="ol-btn ol-btn-primary" disabled={busy || code.length !== 6}>
                  {busy ? 'جارٍ التحقّق…' : 'دخول'}
                </button>
              </div>
            </form>
          )}

          <p className="ol-foot">
            <Link href={`/${params.locale}`}>العودة للصفحة الرئيسية</Link>
          </p>
        </section>
      </main>
    </>
  );
}

function OwnerLoginStyles() {
  return (
    <style jsx global>{`
      .ol-page { max-width: 480px; margin: 0 auto; padding: clamp(20px, 5vw, 48px) 16px; color: var(--ink); }
      .ol-card { background: var(--ground-2); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: clamp(20px, 4vw, 32px); box-shadow: var(--shadow); }
      .ol-card h1 { font-size: 22px; font-weight: 700; margin-block-end: 6px; }
      .ol-muted { color: var(--ink-2); font-size: 13px; margin-block-end: 18px; }
      .ol-field { display: grid; gap: 6px; font-size: 14px; margin-block-end: 14px; }
      .ol-field > span { color: var(--ink-2); font-size: 13px; }
      .ol-field input { padding: 12px 14px; border-radius: var(--radius); border: 1px solid var(--line); background: #fff; font-family: inherit; font-size: 15px; color: var(--ink); min-height: 44px; letter-spacing: .02em; }
      .ol-field input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
      .ol-field input:disabled { background: #f5f2ea; color: var(--ink-2); }
      .ol-btn { padding: 12px 20px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--ground-2); color: var(--ink); font-family: inherit; font-size: 14px; cursor: pointer; min-height: 44px; width: 100%; }
      .ol-btn:hover:not(:disabled) { border-color: var(--accent); }
      .ol-btn:disabled { opacity: .55; cursor: not-allowed; }
      .ol-btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
      .ol-btn-primary:hover:not(:disabled) { background: var(--accent-2); border-color: var(--accent-2); }
      .ol-alert { padding: 10px 12px; border-radius: var(--radius); font-size: 13px; margin-block-end: 12px; background: #f7e2dd; color: var(--danger); }
      .ol-row { display: flex; gap: 8px; }
      .ol-row .ol-btn { flex: 1; }
      .ol-foot { margin-block-start: 18px; text-align: center; font-size: 13px; }
      .ol-foot a { color: var(--accent); text-decoration: underline; }
    `}</style>
  );
}
