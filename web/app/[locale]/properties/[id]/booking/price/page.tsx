'use client';

/**
 * Legacy route — the old dates → price → review flow was consolidated
 * into a single scrollable page at ../booking. Keep this route alive
 * as a redirect so any old link, bookmark, or PR-preview URL still
 * lands somewhere sensible instead of 404.
 */

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LegacyPricePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = use(params);
  const router = useRouter();
  useEffect(() => {
    router.replace(`/${locale}/properties/${id}/booking`);
  }, [router, locale, id]);
  return null;
}
