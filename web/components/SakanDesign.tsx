'use client';

/**
 * SakanDesign — mounts the self-contained SakanHub product design.
 *
 * The design is a JS-driven SPA that fully populates `<div id="app" />`
 * at runtime. Its source (styles + Leaflet + app logic) lives verbatim
 * under `public/vendor/sakan-design/` — we do NOT reimplement it as
 * React components because it already IS a working application; the
 * honest Next.js integration is: React owns the mount point, and the
 * design's own CSS and JS are loaded from static assets around it.
 *
 * Loading order (matters, because app.js calls Leaflet):
 *   1. inject <link rel="stylesheet"> for styles.css (via useEffect)
 *   2. next/script loads leaflet.min.js  (strategy=afterInteractive)
 *   3. onLoad → next/script loads app.js (strategy=afterInteractive)
 *
 * The component intentionally keeps `#app` empty on server-render;
 * everything visible appears after hydration + JS boot. This matches
 * the source design's own behaviour.
 */

import { useEffect, useState } from 'react';
import Script from 'next/script';

const STYLES_HREF   = '/vendor/sakan-design/styles.css';
const LEAFLET_SRC   = '/vendor/sakan-design/leaflet.min.js';
const APP_SRC       = '/vendor/sakan-design/app.js';
const STYLES_LINK_ID = 'sakan-design-styles';

export default function SakanDesign() {
  const [leafletReady, setLeafletReady] = useState(false);

  useEffect(() => {
    // Inject the design's stylesheet exactly once per page load.
    // We avoid importing the .css through Next.js's PostCSS pipeline
    // because the source is a ~400KB hand-authored stylesheet that
    // does not need bundling, minification, or scope changes.
    if (!document.getElementById(STYLES_LINK_ID)) {
      const link = document.createElement('link');
      link.id = STYLES_LINK_ID;
      link.rel = 'stylesheet';
      link.href = STYLES_HREF;
      document.head.appendChild(link);
    }
    // We deliberately do NOT remove the stylesheet on unmount — the
    // design's global tokens are cheap to keep around and re-navigating
    // back would otherwise refetch a large file.

    // Expose the API base URL to the vanilla SPA so its inline tracker
    // (see app.js `_trackEvent`) can POST to /v1/events. Empty string
    // means "no backend wired" and the tracker no-ops silently, which
    // is exactly what we want during the flag rollout window.
    (window as unknown as { __SAKAN_API_BASE?: string }).__SAKAN_API_BASE =
      process.env.NEXT_PUBLIC_API_BASE_URL || '';
  }, []);

  return (
    <>
      <div className="app" id="app" />
      <Script
        src={LEAFLET_SRC}
        strategy="afterInteractive"
        onLoad={() => setLeafletReady(true)}
      />
      {leafletReady && (
        <Script src={APP_SRC} strategy="afterInteractive" />
      )}
    </>
  );
}
