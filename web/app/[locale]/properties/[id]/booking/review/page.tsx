'use client';

/**
 * Legacy route — see ../price/page.tsx for context. Review is now
 * an in-page bottom sheet on ../booking, not a separate route.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LegacyReviewPage({ params }: { params: { locale: string; id: string } }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/${params.locale}/properties/${params.id}/booking`);
  }, [router, params.locale, params.id]);
  return null;
}
