'use client';

/**
 * Shared header for every booking step: back arrow + centered brand mark +
 * step title. All three booking routes render this at the top so the
 * chrome is visually identical and the user always has an obvious way
 * back to the previous step.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';

type Props = {
  title: string;
  fallbackHref: string;
};

export function BookingChrome({ title, fallbackHref }: Props) {
  const router = useRouter();

  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push(fallbackHref);
    }
  };

  return (
    <header className="bkc">
      <button className="bkc-back" onClick={goBack} aria-label="رجوع">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      <Link href="/ar" className="bkc-brand" aria-label="سكن هوب">
        <span className="bkc-brand-mark">S</span>
        <span className="bkc-brand-name">سكن هوب</span>
      </Link>
      <div className="bkc-spacer" />
      <h1 className="bkc-title">{title}</h1>
    </header>
  );
}
