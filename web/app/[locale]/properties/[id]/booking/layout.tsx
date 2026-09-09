import type { ReactNode } from 'react';
import './booking.css';

/**
 * Layout for the booking flow. Sets RTL + the cream ground the mockups
 * call for, without touching any other route. All three step pages
 * (dates → price → review) render inside this shell.
 */
export default function BookingLayout({ children }: { children: ReactNode }) {
  return <div className="bkw" dir="rtl" lang="ar">{children}</div>;
}
