/**
 * Recommendations v1 — orchestrator.
 *
 * `getRecommendationsForUser` builds a bounded candidate set from
 * Prisma, scores each candidate, applies diversity, and returns the
 * top `limit`. `getSimilarPropertyRecommendations` does the same for
 * property-vs-property similarity (see similar-properties.ts).
 *
 * Zero external services. Deterministic. Never throws — a failure
 * anywhere falls through to the cold-start fallback (fresh + quality
 * ordering) so recommendation panels never break a page.
 */

import { getPrisma } from '../db.js';
import { config } from '../config.js';
import { diversifyFeed } from '../services/feed-diversity.js';
import { calculatePropertyQualityScore } from '../services/property-quality-score.js';
import { buildUserInterestProfile } from './user-interest-profile.js';
import { calculateRecommendationScore } from './recommendation-score.js';
import { rankSimilar } from './similar-properties.js';
import type {
  RecommendationContext, RecommendationItem, RecommendationMode,
} from './recommendation-types.js';

const CANDIDATE_CAP = 200;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

type ForUserInput = {
  userId?: string | null;
  sessionId?: string | null;
  mode: RecommendationMode;
  context?: RecommendationContext;
  limit?: number;
  excludePropertyIds?: string[];
};

type ForUserResult = {
  items: RecommendationItem[];
  mode: RecommendationMode;
  personalized: boolean;
  fallback: boolean;
};

function clampLimit(n: number | undefined): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_LIMIT;
  if (v < 1) return DEFAULT_LIMIT;
  if (v > MAX_LIMIT) return MAX_LIMIT;
  return v;
}

async function fetchCandidatePool(prisma: ReturnType<typeof getPrisma>): Promise<any[]> {
  return prisma.property.findMany({
    where: { status: 'available' },
    orderBy: { updatedAt: 'desc' },
    take: CANDIDATE_CAP,
  });
}

/** Cold-start ordering: quality × freshness × has-location. */
function coldStartSort(pool: any[], limit: number): any[] {
  const now = Date.now();
  return pool
    .map((p) => {
      const q = calculatePropertyQualityScore(p).total / 100;
      const ageDays = (now - new Date(p.createdAt ?? p.publishedAt ?? now).getTime()) / (24 * 60 * 60 * 1000);
      const fresh = ageDays <= 30 ? 1 - Math.min(1, ageDays / 30) * 0.5 : 0.2;
      return { p, s: q * 0.7 + fresh * 0.3 };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.p);
}

export async function getRecommendationsForUser(input: ForUserInput): Promise<ForUserResult> {
  const limit = clampLimit(input.limit);

  // Flag off: safe fallback (fresh + quality, no personalisation).
  if (!config.RECOMMENDATIONS_ENABLED) {
    try {
      const pool = await fetchCandidatePool(getPrisma());
      const items: RecommendationItem[] = coldStartSort(pool, limit).map((p) => ({ property: p, score: 0, reasons: ['cold_start'] }));
      return { items, mode: input.mode, personalized: false, fallback: true };
    } catch {
      return { items: [], mode: input.mode, personalized: false, fallback: true };
    }
  }

  try {
    const prisma = getPrisma();
    const [pool, profile] = await Promise.all([
      fetchCandidatePool(prisma),
      buildUserInterestProfile({ userId: input.userId, sessionId: input.sessionId }),
    ]);

    // Mode-specific candidate narrowing.
    let candidates = pool;
    if (input.mode === 'saved_related' && profile.preferredPropertyIds.length === 0) {
      // Nothing to relate to — behave like for_you.
    }
    if (input.mode === 'new_for_you') {
      // Prefer listings created in the last 14 days as the base.
      const since = Date.now() - 14 * 24 * 60 * 60 * 1000;
      candidates = pool.filter((p) => new Date(p.createdAt).getTime() >= since);
      if (candidates.length < limit) candidates = pool; // don't starve the panel
    }

    // Exclusions: user hides/reports + explicit excludePropertyIds.
    const excluded = new Set<string>([
      ...profile.dislikedPropertyIds,
      ...(input.excludePropertyIds ?? []),
    ]);
    candidates = candidates.filter((p) => !excluded.has(p.id));

    // Cold start — no meaningful profile signal.
    const isCold = profile.confidence < 25 && profile.preferredPropertyIds.length === 0;
    if (isCold) {
      const items: RecommendationItem[] = coldStartSort(candidates, limit).map((p) => ({ property: p, score: 0, reasons: ['cold_start'] }));
      return { items, mode: input.mode, personalized: false, fallback: true };
    }

    // Score + rank + diversify.
    const scored = candidates.map((p) => {
      const r = calculateRecommendationScore(p, profile, input.context);
      return { property: p, score: r.score, reasons: r.reasons };
    });
    scored.sort((a, b) => b.score - a.score);
    const pool2 = scored.slice(0, Math.min(scored.length, limit * 3));
    const diversified = diversifyFeed(pool2.map((s) => ({ ...s, ownerId: (s.property as any)?.ownerId, district: (s.property as any)?.district, category: (s.property as any)?.category })));
    const items: RecommendationItem[] = diversified.slice(0, limit).map((s) => ({
      property: (s as any).property,
      score: (s as any).score,
      reasons: (s as any).reasons,
    }));

    return { items, mode: input.mode, personalized: true, fallback: false };
  } catch {
    // Total failure — deliver something safe.
    try {
      const pool = await fetchCandidatePool(getPrisma());
      const items: RecommendationItem[] = coldStartSort(pool, limit).map((p) => ({ property: p, score: 0, reasons: ['cold_start'] }));
      return { items, mode: input.mode, personalized: false, fallback: true };
    } catch {
      return { items: [], mode: input.mode, personalized: false, fallback: true };
    }
  }
}

// ---- Similar --------------------------------------------------------

type SimilarInput = {
  propertyId: string;
  userId?: string | null;
  sessionId?: string | null;
  limit?: number;
};

export async function getSimilarPropertyRecommendations(input: SimilarInput): Promise<{ items: RecommendationItem[] }> {
  const limit = clampLimit(input.limit);
  try {
    const prisma = getPrisma();
    const target = await prisma.property.findUnique({ where: { id: input.propertyId } });
    if (!target || target.status !== 'available') return { items: [] };
    const pool = await fetchCandidatePool(prisma);
    const ranked = rankSimilar(target, pool, limit);
    const items: RecommendationItem[] = ranked.map((r) => ({
      property: r.property,
      score: r.score,
      reasons: ['property_type_match'],
    }));
    return { items };
  } catch {
    return { items: [] };
  }
}
