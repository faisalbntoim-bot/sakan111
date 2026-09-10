'use client';

/**
 * Admin dashboard — reads real aggregates from /v1/admin/dashboard.
 *
 * Auth is enforced by the API (Bearer JWT with ADMIN role). This UI
 * simply surfaces whatever the API returns; 401/403 flip the page to
 * a login prompt. Nothing here is trusted — no local role checks.
 */

import Link from 'next/link';
import { useEffect, useState, useCallback } from 'react';

type Overview = {
  period: string;
  generatedAt: string;
  users: { total: number; newToday: number; owners: number; offices: number; marketers: number; admins: number };
  properties: { total: number; published: number; pending: number; submitted: number; daily: number; annual: number; sale: number };
  bookings: { total: number; today: number; confirmed: number; pending: number; cancelled: number; completed: number; forPeriod: number };
  revenue: { currency: string; totalHalalahs: string; todayHalalahs: string; periodHalalahs: string; last30dHalalahs: string };
  visitors: { today: number | null; uniqueSessionsToday: number | null; propertyViewsToday: number | null; bookingStartsToday: number | null; bookingCompleteToday: number | null };
};

type Period = 'today' | '7d' | '30d';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '';

const AR = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'] as const;
const fmt = (n: number) => n.toLocaleString('ar-SA');
const fmtHalalahs = (h: string) => {
  const sar = Math.round(Number(h) / 100);
  return sar.toLocaleString('ar-SA');
};
const fmtNullable = (v: number | null) => v === null ? 'غير متوفر' : fmt(v);

export default function AdminDashboardPage({ params }: { params: { locale: string } }) {
  const [period, setPeriod] = useState<Period>('today');
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: Period) => {
    setLoading(true); setErr(null);
    if (!API_BASE) {
      setErr('لا يوجد اتصال بالخادم — عرّف NEXT_PUBLIC_API_BASE_URL أولًا.');
      setLoading(false); return;
    }
    try {
      const res = await fetch(`${API_BASE}/v1/admin/dashboard?period=${p}`, {
        credentials: 'include',
        headers: { 'accept': 'application/json' },
      });
      if (res.status === 401 || res.status === 403) {
        setErr('غير مصرَّح — سجّل دخول الإدارة أولًا.');
        setLoading(false); return;
      }
      if (!res.ok) { setErr(`فشل تحميل البيانات (${res.status})`); setLoading(false); return; }
      const json = (await res.json()) as Overview;
      setData(json);
    } catch (e) {
      setErr('لا يمكن الوصول إلى الخادم.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(period); }, [period, load]);

  return (
    <>
      <header className="ad-chrome">
        <div className="ad-title">
          لوحة تحكم سكن هوب
          <small>{data ? `آخر تحديث ${new Date(data.generatedAt).toLocaleString('ar-SA')}` : 'جارِ التحميل…'}</small>
        </div>
        <Link href={`/${params.locale}`} className="ad-back">العودة للتطبيق</Link>
      </header>

      <main className="ad-container">
        <div className="ad-periods" role="tablist" aria-label="الفترة">
          {(['today', '7d', '30d'] as Period[]).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={period === p}
              className={`ad-period ${period === p ? 'on' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p === 'today' ? 'اليوم' : p === '7d' ? 'آخر ٧ أيام' : 'آخر ٣٠ يومًا'}
            </button>
          ))}
        </div>

        {err && (
          <div className="ad-notice err">
            {err}{' '}
            {err.includes('غير مصرَّح') && (
              <Link href={`/${params.locale}/admin/login`} style={{ color: 'inherit', textDecoration: 'underline', marginInlineStart: 6 }}>
                تسجيل الدخول
              </Link>
            )}
          </div>
        )}

        {!err && loading && <div className="ad-notice">جارِ تحميل المؤشرات…</div>}

        {!err && data && (
          <>
            <div className="ad-section-title">نظرة سريعة <small>مباشرة من قاعدة البيانات</small></div>
            <div className="ad-grid">
              <Stat k="إجمالي المستخدمين" v={fmt(data.users.total)} />
              <Stat k="جدد اليوم" v={fmt(data.users.newToday)} />
              <Stat k="مكاتب" v={fmt(data.users.offices)} />
              <Stat k="ملاّك" v={fmt(data.users.owners)} />
              <Stat k="مسوّقون" v={fmt(data.users.marketers)} />
              <Stat k="مسؤولون" v={fmt(data.users.admins)} />
              <Stat k="زوار اليوم" v={fmtNullable(data.visitors.today)} nullish={data.visitors.today === null} />
              <Stat k="جلسات فريدة اليوم" v={fmtNullable(data.visitors.uniqueSessionsToday)} nullish={data.visitors.uniqueSessionsToday === null} />
            </div>

            <div className="ad-section-title">العقارات</div>
            <div className="ad-grid">
              <Stat k="الإجمالي" v={fmt(data.properties.total)} />
              <Stat k="منشور" v={fmt(data.properties.published)} />
              <Stat k="قيد المراجعة" v={fmt(data.properties.submitted)} />
              <Stat k="مسوّدة" v={fmt(data.properties.pending)} />
              <Stat k="إيجار يومي" v={fmt(data.properties.daily)} />
              <Stat k="إيجار سنوي" v={fmt(data.properties.annual)} />
              <Stat k="للبيع" v={fmt(data.properties.sale)} />
            </div>

            <div className="ad-section-title">الحجوزات</div>
            <div className="ad-grid">
              <Stat k="الإجمالي" v={fmt(data.bookings.total)} />
              <Stat k="اليوم" v={fmt(data.bookings.today)} />
              <Stat k="مؤكد" v={fmt(data.bookings.confirmed)} />
              <Stat k="معلّق" v={fmt(data.bookings.pending)} />
              <Stat k="ملغى" v={fmt(data.bookings.cancelled)} />
              <Stat k="مكتمل" v={fmt(data.bookings.completed)} />
              <Stat k="خلال الفترة" v={fmt(data.bookings.forPeriod)} />
            </div>

            <div className="ad-section-title">الإيرادات <small>{data.revenue.currency} — حلالة → ريال</small></div>
            <div className="ad-card">
              <div className="ad-row"><span className="ad-k">إجمالي (منذ البداية)</span><span className="ad-v ad-money">{fmtHalalahs(data.revenue.totalHalalahs)} ر.س</span></div>
              <div className="ad-row"><span className="ad-k">اليوم</span><span className="ad-v ad-money">{fmtHalalahs(data.revenue.todayHalalahs)} ر.س</span></div>
              <div className="ad-row"><span className="ad-k">آخر {period === '7d' ? '٧ أيام' : period === '30d' ? '٣٠ يومًا' : 'اليوم'}</span><span className="ad-v ad-money">{fmtHalalahs(data.revenue.periodHalalahs)} ر.س</span></div>
              <div className="ad-row"><span className="ad-k">آخر ٣٠ يومًا</span><span className="ad-v ad-money">{fmtHalalahs(data.revenue.last30dHalalahs)} ر.س</span></div>
            </div>

            <div className="ad-section-title">قِمع الحجوزات اليوم <small>من مصدر الأحداث</small></div>
            <div className="ad-card">
              <div className="ad-row"><span className="ad-k">مشاهدات عقارات</span><span className={`ad-v ${data.visitors.propertyViewsToday === null ? 'ad-null' : ''}`}>{fmtNullable(data.visitors.propertyViewsToday)}</span></div>
              <div className="ad-row"><span className="ad-k">بدء حجز</span><span className={`ad-v ${data.visitors.bookingStartsToday === null ? 'ad-null' : ''}`}>{fmtNullable(data.visitors.bookingStartsToday)}</span></div>
              <div className="ad-row"><span className="ad-k">إتمام حجز</span><span className={`ad-v ${data.visitors.bookingCompleteToday === null ? 'ad-null' : ''}`}>{fmtNullable(data.visitors.bookingCompleteToday)}</span></div>
            </div>
          </>
        )}
      </main>
    </>
  );
}

function Stat({ k, v, nullish }: { k: string; v: string; nullish?: boolean }) {
  return (
    <div className="ad-stat">
      <span className="ad-s-k">{k}</span>
      <span className={`ad-s-v ${nullish ? 'ad-null' : ''}`}>{v}</span>
    </div>
  );
}
