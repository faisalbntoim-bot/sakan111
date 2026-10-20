'use client';

/**
 * Small property card shown at the top of the price and review steps so
 * the user can confirm at a glance which listing they're booking.
 *
 * Image comes from the SPA's static gallery (photoIndex → /vendor/...).
 */

import type { PropertyRecord } from '@/lib/properties';
type Props = {
  property: PropertyRecord;
};

const AR_DIGITS = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'] as const;

// Format a rating like 4.8 → "٤٫٨".
function arRating(n: number): string {
  return n.toFixed(1).split('').map(c => (c === '.' ? '٫' : AR_DIGITS[Number(c)])).join('');
}

// Photos in the SPA are inline data URIs (not exposed as separate files)
// so booking pages can't reuse them directly. We render a warm brand
// gradient keyed to the same photoIndex so each property still gets a
// distinct visual token — enough for the mini card's role as a
// "which listing am I booking?" reminder.
const GRADIENTS: Record<number, string> = {
  1: 'linear-gradient(135deg, #0E7C66 0%, #14a482 55%, #C7A252 100%)',
  2: 'linear-gradient(135deg, #0A6B54 0%, #5AB69C 60%, #B58A2C 100%)',
  3: 'linear-gradient(135deg, #6FBF9A 0%, #0E7C66 55%, #0A3E33 100%)',
  4: 'linear-gradient(135deg, #C7A252 0%, #8A6A1A 55%, #0A6B54 100%)',
  5: 'linear-gradient(135deg, #0A3E33 0%, #0E7C66 50%, #5AB69C 100%)',
};

export function PropertyMiniCard({ property }: Props) {
  const bg = GRADIENTS[property.photoIndex] ?? GRADIENTS[1];
  return (
    <div className="pmc">
      <div
        className="pmc-thumb"
        style={{ background: bg }}
        role="img"
        aria-label={property.name}
      >
        <span className="pmc-thumb-mark">{property.category.slice(0, 1)}</span>
      </div>
      <div className="pmc-body">
        <b className="pmc-name">{property.name}</b>
        <span className="pmc-loc">{property.neighborhood} · {property.city}</span>
        {property.rating > 0 && (
          <span className="pmc-rating">
            <span aria-hidden="true">★</span>
            {' '}
            {arRating(property.rating)}
          </span>
        )}
      </div>
    </div>
  );
}
