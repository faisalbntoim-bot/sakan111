'use client';

/**
 * Placeholder page for the next stage (payment). We do NOT wire a fake
 * payment gateway here — Moyasar / mada / Apple Pay integration lives
 * in a separate task. This page exists so the review CTA lands on a
 * clean, honest route instead of a 404.
 */

import { BookingChrome } from '@/components/booking/BookingChrome';

export default function BookingPayPage({ params }: { params: { locale: string; id: string } }) {
  const backHref = `/${params.locale}/properties/${params.id}/booking/review`;
  return (
    <>
      <BookingChrome title="الدفع" fallbackHref={backHref} />
      <main className="bkp">
        <div className="bks" style={{ textAlign: 'center', padding: '32px 20px' }}>
          <div style={{ fontSize: 42, marginBottom: 12 }} aria-hidden="true">🔒</div>
          <b style={{ display: 'block', fontSize: 17, color: '#0A3E33', marginBottom: 8 }}>
            بوابة الدفع قيد التفعيل
          </b>
          <p style={{ margin: 0, color: '#5B6B65', fontSize: 13, lineHeight: 1.7 }}>
            سيتم ربط الدفع الفعلي عبر مزوّد مرخّص في المرحلة القادمة.
            بيانات حجزك محفوظة، ويمكنك العودة لتعديلها في أي وقت.
          </p>
          <a
            href={backHref}
            style={{
              display: 'inline-block', marginTop: 18,
              padding: '10px 18px', borderRadius: 10,
              background: '#fff', border: '1px solid rgba(14,124,102,.20)',
              color: '#0A6B54', textDecoration: 'none', fontWeight: 800, fontSize: 13,
            }}
          >
            رجوع للمراجعة
          </a>
        </div>
      </main>
    </>
  );
}
