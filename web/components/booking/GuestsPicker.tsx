'use client';

/**
 * Compact three-row guests counter (adults / children / infants).
 * Adults have a minimum of 1; children and infants start at 0. The
 * maxGuests cap counts adults + children only — infants don't count
 * toward capacity per common short-let convention.
 */

import { nfA } from '@/lib/booking-state';

type Props = {
  adults: number;
  children: number;
  infants: number;
  maxGuests: number; // 0 = no cap
  onChange: (next: { adults: number; children: number; infants: number }) => void;
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

export function GuestsPicker({ adults, children, infants, maxGuests, onChange }: Props) {
  const capReached = maxGuests > 0 && adults + children >= maxGuests;
  return (
    <div className="gp">
      <Row
        label="البالغون"
        hint="١٣ سنة فأكثر"
        value={adults}
        min={1}
        canInc={!capReached}
        onDec={() => onChange({ adults: adults - 1, children, infants })}
        onInc={() => onChange({ adults: adults + 1, children, infants })}
      />
      <Row
        label="الأطفال"
        hint="من ٢ إلى ١٢ سنة"
        value={children}
        min={0}
        canInc={!capReached}
        onDec={() => onChange({ adults, children: children - 1, infants })}
        onInc={() => onChange({ adults, children: children + 1, infants })}
      />
      <Row
        label="الرضع"
        hint="أقل من سنتين"
        value={infants}
        min={0}
        canInc={true}
        onDec={() => onChange({ adults, children, infants: infants - 1 })}
        onInc={() => onChange({ adults, children, infants: infants + 1 })}
      />
      {maxGuests > 0 && (
        <div className="gp-note">الحد الأقصى لهذا العقار: {nfA(maxGuests)} ضيوف</div>
      )}
    </div>
  );
}
