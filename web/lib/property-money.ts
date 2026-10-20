/**
 * Price conversion helpers for the Property Authoring flow.
 *
 * The backend stores prices as integer halalahs (BigInt) — the same
 * convention Booking.grossAmountHalalahs uses. The UI must display
 * SAR (major units) and never expose the halalah representation.
 *
 * Rules:
 *   - Integer halalahs only. Never floats. Rounds half-away-from-zero.
 *   - Empty / non-numeric inputs return null (caller decides how to
 *     surface: hint text vs. hard validation).
 *   - Locale-aware formatting via Intl.NumberFormat('ar-SA') so
 *     Arabic digits + separators match the rest of the SakanHub UI.
 */

/** Convert a user-entered SAR value to integer halalahs. Returns null when input is empty / not a finite number. */
export function halalahsFromSAR(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const raw = typeof input === 'number' ? input : String(input).trim();
  if (raw === '' || raw === '-') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  // Multiply by 100 in a way that avoids float artefacts (e.g. 79.9 * 100 = 7989.999…).
  const [whole, frac = ''] = String(Math.abs(n)).split('.');
  const wholeH = Number(whole) * 100;
  const fracPadded = (frac + '00').slice(0, 2);
  const fracH = Number(fracPadded);
  const halalahs = wholeH + fracH;
  return n < 0 ? -halalahs : halalahs;
}

/** Convert integer halalahs (bigint, number, or string) to a SAR number for display. */
export function sarFromHalalahs(halalahs: bigint | number | string | null | undefined): number | null {
  if (halalahs === null || halalahs === undefined) return null;
  if (typeof halalahs === 'bigint') return Number(halalahs) / 100;
  if (typeof halalahs === 'number') return Number.isFinite(halalahs) ? halalahs / 100 : null;
  if (typeof halalahs === 'string') {
    const n = Number(halalahs);
    return Number.isFinite(n) ? n / 100 : null;
  }
  return null;
}

const NF_AR = new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 0 });

/** Format halalahs as an Arabic-locale SAR string, e.g. "٧٥٠٬٠٠٠". */
export function formatHalalahsAr(halalahs: bigint | number | string | null | undefined): string {
  const sar = sarFromHalalahs(halalahs);
  if (sar === null) return '—';
  return NF_AR.format(Math.round(sar));
}

/** Round-trip check helper — mostly used in tests / dev asserts. */
export function isHalalahRoundTripSafe(sar: number): boolean {
  const h = halalahsFromSAR(sar);
  if (h === null) return false;
  const back = sarFromHalalahs(h);
  return back !== null && Math.abs(back - sar) < 0.005;
}
