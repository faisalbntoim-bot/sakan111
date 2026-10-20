import type { ReactNode } from 'react';
import './admin.css';

/**
 * Admin segment layout.
 *
 * Uses the same SakanHub identity as the rest of the site: dark
 * backdrop from the SPA (--ink:#0F1E18) via admin.css so /ar → /admin
 * feels like the same product. This layout is a bare RTL wrapper; the
 * per-page components render their own chrome.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div className="adw" dir="rtl" lang="ar">{children}</div>;
}
