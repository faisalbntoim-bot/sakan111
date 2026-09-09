import type { ReactNode } from 'react';
import './booking.css';

/**
 * Layout for the booking flow. Sets RTL + the cream ground the mockups
 * call for, without touching any other route. All three step pages
 * (dates → price → review) render inside this shell.
 */
export default function BookingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bkw-stage" dir="rtl" lang="ar">
      <div className="bkw" dir="rtl" lang="ar">
        <div className="bkw-status" aria-hidden="true">
          <span className="bkw-status-time">٩:٤١</span>
          <span className="bkw-status-notch" />
          <span className="bkw-status-icons">
            <svg viewBox="0 0 18 12" width="18" height="12" fill="currentColor" aria-hidden="true">
              <rect x="0" y="8" width="3" height="4" rx="1"/>
              <rect x="4" y="6" width="3" height="6" rx="1"/>
              <rect x="8" y="3" width="3" height="9" rx="1"/>
              <rect x="12" y="0" width="3" height="12" rx="1"/>
            </svg>
            <svg viewBox="0 0 16 12" width="16" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M1 5.5C3 3 5.5 2 8 2s5 1 7 3.5"/>
              <path d="M3 7.5C4.5 6 6.2 5.3 8 5.3s3.5.7 5 2.2"/>
              <circle cx="8" cy="10" r="1" fill="currentColor"/>
            </svg>
            <svg viewBox="0 0 26 12" width="26" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <rect x="1" y="2" width="21" height="8" rx="2"/>
              <rect x="3" y="4" width="15" height="4" rx="1" fill="currentColor"/>
              <path d="M23.5 4v4"/>
            </svg>
          </span>
        </div>
        <div className="bkw-scroll">{children}</div>
        <div className="bkw-home-indicator" aria-hidden="true" />
      </div>
    </div>
  );
}
