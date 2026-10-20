/**
 * Feed diversification — light reordering pass applied AFTER scoring.
 *
 * Rule: never show more than `MAX_STREAK` consecutive items with the
 * same `advertiser`, `district`, or `propertyType`. Offending items are
 * pushed further down the list (never dropped) until the streak breaks.
 *
 * Deterministic: same input → same output. No randomness so the feed
 * is stable across identical requests (important for pagination).
 */

const MAX_STREAK = 3;

type Key = string | number | null | undefined;

function advertiserKey(p: any): Key {
  return p?.ownerId ?? p?.owner?.id ?? p?.officeId ?? p?.office?.id ?? null;
}
function districtKey(p: any): Key {
  return p?.district ?? p?.neighborhood ?? null;
}
function typeKey(p: any): Key {
  return p?.category ?? p?.type ?? null;
}

/**
 * Returns true if inserting `next` at position `i` would create a
 * streak longer than MAX_STREAK for ANY of the three grouping keys.
 */
function wouldOverStreak(previousItems: any[], next: any): boolean {
  if (previousItems.length < MAX_STREAK) return false;
  const window = previousItems.slice(-MAX_STREAK);
  for (const keyFn of [advertiserKey, districtKey, typeKey]) {
    const k = keyFn(next);
    if (k === null || k === undefined) continue;
    const allSame = window.every((w) => keyFn(w) === k);
    if (allSame) return true;
  }
  return false;
}

/**
 * Diversifies an already-scored feed. Iterates greedily: at each slot,
 * pick the highest-scored remaining item that does NOT create a
 * MAX_STREAK+1 run. If every candidate would, we pick the top one
 * anyway (better to break the rule than to stall the feed forever).
 */
export function diversifyFeed<T extends Record<string, unknown>>(properties: T[]): T[] {
  if (!Array.isArray(properties) || properties.length <= MAX_STREAK) {
    return properties;
  }
  // Copy so we can shrink; assume caller has already sorted by score desc.
  const remaining = properties.slice();
  const out: T[] = [];
  while (remaining.length > 0) {
    let pickIdx = -1;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      if (candidate === undefined) continue;
      if (!wouldOverStreak(out, candidate)) { pickIdx = i; break; }
    }
    // Fallback: nothing satisfies the streak rule — pick the head and
    // move on so the loop terminates.
    if (pickIdx === -1) pickIdx = 0;
    const picked = remaining[pickIdx];
    if (picked !== undefined) out.push(picked);
    remaining.splice(pickIdx, 1);
  }
  return out;
}
