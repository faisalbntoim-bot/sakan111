'use client';

/**
 * /pay is now folded into the booking Bottom Sheet — the method picker
 * and pay CTA live there so the user never leaves the booking screen.
 * This route is kept as a Redirect so any bookmark or old link lands
 * on the current flow instead of 404.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LegacyPayPage({ params }: { params: { locale: string; id: string } }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/${params.locale}/properties/${params.id}/booking`);
  }, [router, params.locale, params.id]);
  return null;
}
