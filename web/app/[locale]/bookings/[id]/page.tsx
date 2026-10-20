'use client';


import { use } from 'react';
/**
 * Booking confirmation page.
 *
 * The test harness and real users land here after /v1/payments has
 * been captured. The page re-reads /v1/bookings/:id so the status
 * survives a browser refresh — nothing is held in client memory.
 *
 * No action buttons: at this stage the booking is confirmed and the
 * follow-up (invoice, cancellation window) is read-only.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchBooking, BookingApiError } from '@/lib/booking-api';

type Status = 'draft' | 'pending_payment' | 'confirmed' | 'cancelled' | 'completed' | 'failed';

const STATUS_AR: Record<Status, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  draft:            { label: 'مسودة',             tone: 'warn' },
  pending_payment:  { label: 'بانتظار الدفع',     tone: 'warn' },
  confirmed:        { label: 'مؤكد',               tone: 'ok'   },
  cancelled:        { label: 'ملغي',               tone: 'bad'  },
  completed:        { label: 'منتهي',              tone: 'ok'   },
  failed:           { label: 'فشل الدفع',          tone: 'bad'  },
};

function nfA(n: number): string {
  return new Intl.NumberFormat('ar-SA').format(n);
}

function formatArabicDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  } catch { return '—'; }
}

export default function BookingConfirmationPage({ params: _params }: { params: Promise<{ locale: string; id: string }> }) {
  const params = use(_params);
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; row: Awaited<ReturnType<typeof fetchBooking>> }>({ kind: 'loading' });

  const reload = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const row = await fetchBooking(params.id);
      setState({ kind: 'ready', row });
    } catch (e) {
      if (e instanceof BookingApiError) {
        if (e.httpStatus === 401) { setState({ kind: 'error', message: 'انتهت الجلسة. سجّل الدخول من جديد ثم أعد فتح هذا الرابط.' }); return; }
        if (e.httpStatus === 404) { setState({ kind: 'error', message: 'لم يتم العثور على الحجز.' }); return; }
      }
      setState({ kind: 'error', message: 'تعذّر تحميل تفاصيل الحجز.' });
    }
  }, [params.id]);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <main dir="rtl" className="bcf" style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>تفاصيل الحجز</h1>

        {state.kind === 'loading' && <div role="status">جارٍ التحميل…</div>}

        {state.kind === 'error' && (
          <div role="alert" style={styles.alert}>
            {state.message}
            <button type="button" onClick={() => void reload()} style={styles.btn} data-testid="bcf-retry">إعادة المحاولة</button>
          </div>
        )}

        {state.kind === 'ready' && (() => {
          const row = state.row;
          const status = (row.status as Status) in STATUS_AR ? (row.status as Status) : 'draft';
          const meta = STATUS_AR[status];
          const totalMajor = Math.round(Number(row.grossAmountHalalahs) / 100);
          const paymentStatus = row.payments?.[0]?.status || '—';
          return (
            <>
              <div style={styles.statusRow}>
                <span style={styles.statusLabel}>الحالة</span>
                <span data-testid="bcf-status" data-status={status} style={{ ...styles.statusBadge, ...toneStyle(meta.tone) }}>
                  {meta.label}
                </span>
              </div>
              <div style={styles.kv}>
                <div><b data-testid="bcf-booking-id">{row.id}</b><span>معرّف الحجز</span></div>
                <div><b>{formatArabicDate(row.checkIn)}</b><span>الوصول</span></div>
                <div><b>{formatArabicDate(row.checkOut)}</b><span>المغادرة</span></div>
                <div><b>{row.nights != null ? `${nfA(row.nights)} ليالٍ` : '—'}</b><span>عدد الليالي</span></div>
                <div><b>{nfA(totalMajor)} ر.س</b><span>الإجمالي</span></div>
                <div><b>{paymentStatus}</b><span>حالة الدفع</span></div>
                <div><b>{row.invoice?.id || '—'}</b><span>فاتورة</span></div>
              </div>
              <div style={styles.actions}>
                <Link href={`/${params.locale}`} style={styles.btnLink}>العودة للصفحة الرئيسية</Link>
                <button type="button" onClick={() => void reload()} style={styles.btn} data-testid="bcf-reload">تحديث</button>
              </div>
            </>
          );
        })()}
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { maxWidth: 560, margin: '0 auto', padding: 'clamp(16px, 4vw, 32px) 16px', color: 'var(--ink)' },
  card: { background: 'var(--ground-2)', border: '1px solid var(--line)', borderRadius: 16, padding: 'clamp(16px, 4vw, 24px)' },
  title: { fontSize: 22, fontWeight: 700, marginBlockEnd: 16 },
  statusRow: { display: 'flex', alignItems: 'center', gap: 10, marginBlockEnd: 16 },
  statusLabel: { color: 'var(--ink-2)', fontSize: 13 },
  statusBadge: { padding: '4px 10px', borderRadius: 999, fontSize: 13, fontWeight: 700 },
  kv: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 },
  actions: { display: 'flex', gap: 8, marginBlockStart: 20 },
  btn: { padding: '10px 16px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--ground-2)', cursor: 'pointer' },
  btnLink: { padding: '10px 16px', borderRadius: 12, background: 'var(--accent)', color: '#fff', textDecoration: 'none', border: '1px solid var(--accent)' },
  alert: { padding: 12, borderRadius: 12, background: '#f7e2dd', color: 'var(--danger)' },
};

function toneStyle(tone: 'ok' | 'warn' | 'bad'): React.CSSProperties {
  if (tone === 'ok')  return { background: '#dcf5df', color: '#0c6b24' };
  if (tone === 'bad') return { background: '#f7e2dd', color: '#9c1c1c' };
  return { background: '#fff3cd', color: '#7a5a00' };
}
