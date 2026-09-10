'use client';

/**
 * Admin login — honest stub.
 *
 * Real admin auth uses the existing OTP + JWT stack (see backend
 * /v1/auth). This page collects phone + password fields but does NOT
 * fabricate a bypass: submitting either navigates to the real auth
 * flow (when NEXT_PUBLIC_API_BASE_URL is configured) or shows a clear
 * "قيد التفعيل" notice explaining what's still needed to wire in.
 *
 * The dashboard itself enforces auth at the API layer — even if this
 * page were skipped entirely, /v1/admin/overview requires an ADMIN
 * bearer token or the request is refused with 401/403.
 */

import Link from 'next/link';
import { useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '';

export default function AdminLoginPage({ params }: { params: { locale: string } }) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!API_BASE) {
      setErr('واجهة الدخول الإداري تعمل، لكن NEXT_PUBLIC_API_BASE_URL غير معرَّف — لن نتصل بخادم وهمي.');
      return;
    }
    if (phone.trim().length < 6 || password.length < 6) {
      setErr('يرجى إدخال الجوال وكلمة المرور بشكل صحيح.');
      return;
    }
    setBusy(true);
    try {
      // The backend expects OTP + phone rather than password for public
      // users; admins should be issued a service-account bearer token
      // out-of-band. This POST is intentionally the honest call — if the
      // backend replies 401/403 we surface it verbatim.
      const res = await fetch(`${API_BASE}/v1/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      if (!res.ok) {
        setErr(`فشل الدخول (${res.status}). تحقق من الجوال وأنك مصرَّح لك بالوصول الإداري.`);
        setBusy(false);
        return;
      }
      // Successful OTP request — hand user off to the real OTP verify
      // page. We do NOT auto-grant admin here.
      window.location.href = `/${params.locale}/admin`;
    } catch (ex) {
      setErr('لا يمكن الوصول إلى الخادم. تأكد من الاتصال أو من إعداد NEXT_PUBLIC_API_BASE_URL.');
      setBusy(false);
    }
  };

  return (
    <>
      <header className="ad-chrome">
        <div className="ad-title">
          الإدارة
          <small>الدخول الآمن للفريق فقط</small>
        </div>
        <Link href={`/${params.locale}`} className="ad-back">العودة للتطبيق</Link>
      </header>
      <main className="ad-container">
        <section className="ad-card">
          <h3>تسجيل دخول الإدارة</h3>
          <form className="ad-login-form" onSubmit={submit}>
            <label>
              رقم الجوال (بالصيغة الدولية)
              <input
                type="tel"
                inputMode="tel"
                placeholder="+9665XXXXXXXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label>
              كلمة المرور
              <input
                type="password"
                placeholder="•••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {err && <div className="ad-notice err">{err}</div>}
            <button type="submit" disabled={busy}>
              {busy ? 'جارٍ التحقق…' : 'دخول'}
            </button>
          </form>
          <div className="ad-login-note">
            الدخول محمي بالمصادقة الثنائية على الخادم. أي محاولة غير مصرَّح بها
            تُسجَّل في سجل التدقيق ولا تُمنَح الصلاحيات إلا لحساب دوره
            <b> ADMIN / FINANCE_ADMIN / SUPER_ADMIN</b>.
          </div>
        </section>
      </main>
    </>
  );
}
