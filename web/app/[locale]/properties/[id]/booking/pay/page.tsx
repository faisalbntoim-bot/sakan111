'use client';

/**
 * /pay is now folded into the booking Bottom Sheet — the method picker
 * and pay CTA live there so the user never leaves the booking screen.
 * This route is kept as a Redirect so any bookmark or old link lands
 * on the current flow instead of 404.
 */

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LegacyPayPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = use(params);
  const router = useRouter();
  useEffect(() => {
    router.replace(`/${locale}/properties/${id}/booking`);
  }, [router, locale, id]);
  return null;
}
