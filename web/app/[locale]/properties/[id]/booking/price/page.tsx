'use client';

/**
 * Legacy route — the old dates → price → review flow was consolidated
 * into a single scrollable page at ../booking. Keep this route alive
 * as a redirect so any old link, bookmark, or PR-preview URL still
 * lands somewhere sensible instead of 404.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LegacyPricePage({ params }: { params: { locale: string; id: string } }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/${params.locale}/properties/${params.id}/booking`);
  }, [router, params.locale, params.id]);
  return null;
}
