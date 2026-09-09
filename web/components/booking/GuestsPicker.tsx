'use client';

/**
 * Two-row guests counter used on the dates step. Adults have a minimum
 * of 1; children start at 0. If the property specifies a maxGuests, the
 * combined total cannot exceed it.
 */

import { nfA } from '@/lib/booking-state';

type Props = {
  adults: number;
  children: number;
  maxGuests: number; // 0 = no cap (e.g. land parcels)
  onChange: (next: { adults: number; children: number }) => void;
};

function Row({
  label,
  hint,
  value,
  min,
  canInc,
  onDec,
  onInc,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  canInc: boolean;
  onDec: () => void;
  onInc: () => void;
}) {
  const canDec = value > min;
  return (
    <div className="gp-row">
      <div className="gp-tx">
        <b>{label}</b>
        <span>{hint}</span>
      </div>
      <div className="gp-ctrl">
        <button
          type="button"
          className="gp-btn"
          onClick={onDec}
          disabled={!canDec}
          aria-label={`إنقاص ${label}`}
        >−</button>
        <span className="gp-val">{nfA(value)}</span>
        <button
          type="button"
          className="gp-btn"
          onClick={onInc}
          disabled={!canInc}
          aria-label={`زيادة ${label}`}
        >+</button>
      </div>
    </div>
  );
}

export function GuestsPicker({ adults, children, maxGuests, onChange }: Props) {
  const capReached = maxGuests > 0 && adults + children >= maxGuests;
  return (
    <div className="gp">
      <Row
        label="البالغون"
        hint="١٣ سنة فأكثر"
        value={adults}
        min={1}
        canInc={!capReached}
        onDec={() => onChange({ adults: adults - 1, children })}
        onInc={() => onChange({ adults: adults + 1, children })}
      />
      <Row
        label="الأطفال"
        hint="من ٢ إلى ١٢ سنة"
        value={children}
        min={0}
        canInc={!capReached}
        onDec={() => onChange({ adults, children: children - 1 })}
        onInc={() => onChange({ adults, children: children + 1 })}
      />
      {maxGuests > 0 && (
        <div className="gp-note">
          الحد الأقصى للضيوف لهذا العقار: {nfA(maxGuests)}
        </div>
      )}
    </div>
  );
}
