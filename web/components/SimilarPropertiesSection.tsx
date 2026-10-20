'use client';

/**
 * "عقارات مشابهة" — supplementary panel shown at the bottom of the
 * booking / property view. Fully non-critical:
 *
 *   - Renders nothing until the client-side fetch resolves.
 *   - Renders nothing if the endpoint returns [] (flag off, no matches,
 *     backend unreachable, non-2xx — all silent).
 *   - Never blocks navigation; the fetch is aborted on unmount.
 *
 * The endpoint (/v1/properties/:id/similar) is safe by default:
 * with RECOMMENDATIONS_ENABLED=false it returns { items: [] }, so
 * this component is safe to mount before rollout.
 */

import { useEffect, useState } from 'react';
import { getSimilarProperties, type RecommendationItem } from '@/lib/recommendations';

type Props = {
  propertyId: string;
  limit?: number;
};

export function SimilarPropertiesSection({ propertyId, limit = 6 }: Props) {
  const [items, setItems] = useState<RecommendationItem[] | null>(null);

  useEffect(() => {
    if (!propertyId) return;
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      const list = await getSimilarProperties(propertyId, limit, ctrl.signal);
      if (!cancelled) setItems(list);
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [propertyId, limit]);

  if (!items || items.length === 0) return null;

  return (
    <section
      dir="rtl"
      aria-labelledby="similar-heading"
      style={{
        marginTop: 24,
        padding: '16px 12px',
        borderTop: '1px solid #e5e7eb',
      }}
    >
      <h2
        id="similar-heading"
        style={{ fontSize: 18, fontWeight: 700, marginBottom: 12, color: '#111827' }}
      >
        عقارات مشابهة
      </h2>
      <ul
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 12,
          listStyle: 'none',
          padding: 0,
          margin: 0,
        }}
      >
        {items.map((it, i) => {
          const id = typeof it.id === 'string' ? it.id : `sim-${i}`;
          const listingNumber = typeof it.listingNumber === 'string' ? it.listingNumber : '';
          const category = typeof it.category === 'string' ? it.category : '';
          const purpose = typeof it.purpose === 'string' ? it.purpose : '';
          const reasonAr = typeof it.reasonAr === 'string' ? it.reasonAr : '';
          return (
            <li
              key={id}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 12,
                padding: 12,
                background: '#fff',
              }}
            >
              <div style={{ fontSize: 13, color: '#6b7280' }}>
                {listingNumber || '—'}
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#111827', marginTop: 4 }}>
                {category || 'عقار'}
              </div>
              {purpose ? (
                <div style={{ fontSize: 12, color: '#4b5563', marginTop: 2 }}>{purpose}</div>
              ) : null}
              {reasonAr ? (
                <div
                  style={{
                    fontSize: 11,
                    color: '#065f46',
                    background: '#ecfdf5',
                    borderRadius: 6,
                    padding: '3px 6px',
                    display: 'inline-block',
                    marginTop: 6,
                  }}
                >
                  {reasonAr}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
