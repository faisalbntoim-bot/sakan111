'use client';

/**
 * Legacy route — see ../price/page.tsx for context. Review is now
 * an in-page bottom sheet on ../booking, not a separate route.
 */

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LegacyReviewPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = use(params);
  const router = useRouter();
  useEffect(() => {
    router.replace(`/${locale}/properties/${id}/booking`);
  }, [router, locale, id]);
  return null;
}
