import type { ReactNode } from 'react';
import './booking.css';

/**
 * Layout for the booking flow.
 *
 * Deliberately plain: the previous version wrapped everything in a
 * fake phone-frame (iOS status bar + notch + home-indicator) which
 * made the /booking route feel like a different app after the user
 * clicked "احجز الآن" inside the SPA. Now the layout is a bare RTL
 * shell that inherits the site's normal chrome so the booking screen
 * reads as a direct continuation of the property page the user came
 * from — same paper background, same tokens, no device mockup.
 */
export default function BookingLayout({ children }: { children: ReactNode }) {
  return <div className="bkw" dir="rtl" lang="ar">{children}</div>;
}
