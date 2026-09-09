'use client';

/**
 * PlayCanvas-based property viewer — client component.
 *
 * ⚠️  Loads the PlayCanvas engine LAZILY from a CDN (cdn.jsdelivr.net) via
 *     a `<script>` tag inserted on mount. It never runs during SSR and
 *     never blocks the initial page paint.
 *
 * ⚠️  Renders NOTHING when `NEXT_PUBLIC_PROPERTY_3D_VIEWER_ENABLED` is
 *     off. Safe to import and mount anywhere; the layout is unchanged
 *     for the default build.
 *
 * ⚠️  Even when enabled, this component does NOT process content — it
 *     only PLAYS BACK a pre-baked scene URL. Producing that scene
 *     (COLMAP + gsplat training + SuperSplat/SOG compression) is a
 *     separate cloud-GPU pipeline outside this repository.
 */

import { useEffect, useRef, useState } from 'react';
import { webFeatureFlags } from '@/lib/feature-flags';

const PLAYCANVAS_CDN =
  'https://cdn.jsdelivr.net/npm/playcanvas@2.4.4/build/playcanvas.min.js';

type Props = {
  /** Absolute URL to a pre-baked scene asset (.splat / .ply / .glb). */
  sceneUrl: string;
  height?: number;
};

type Status = 'idle' | 'loading-engine' | 'ready' | 'unavailable' | 'error';

export function PlayCanvasViewer({ sceneUrl, height = 480 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!webFeatureFlags.PROPERTY_3D_VIEWER_ENABLED) {
      setStatus('unavailable');
      setMessage('3D viewer is not enabled on this deployment.');
      return;
    }
    if (!sceneUrl) {
      setStatus('unavailable');
      setMessage('No scene URL provided.');
      return;
    }

    let cancelled = false;
    setStatus('loading-engine');

    loadPlayCanvasOnce()
      .then(() => {
        if (cancelled) return;
        // PlayCanvas is now on window as `pc`. We deliberately do NOT
        // ship a splat-decoder here — enabling a real 3DGS viewer requires
        // a pre-baked scene URL served by the (not-included) processing
        // pipeline. Show an honest "ready to receive scene" state.
        setStatus('ready');
        setMessage(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'Failed to load 3D engine.');
      });

    return () => { cancelled = true; };
  }, [sceneUrl]);

  if (!webFeatureFlags.PROPERTY_3D_VIEWER_ENABLED) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#111',
        color: '#eee',
        borderRadius: 12,
        fontFamily: 'system-ui, sans-serif',
        textAlign: 'center',
        padding: 24,
      }}
    >
      {status === 'loading-engine' && <span>جاري تحميل محرك العرض…</span>}
      {status === 'ready' && (
        <span>
          محرك العرض جاهز. اربط عنوان مشهد جاهز (‎.splat/.ply)
          يأتي من خط معالجة GPU خارجي لعرضه هنا.
        </span>
      )}
      {status === 'unavailable' && <span>{message}</span>}
      {status === 'error' && <span>خطأ: {message}</span>}
    </div>
  );
}

// ---------- helpers ----------

let playCanvasPromise: Promise<void> | null = null;

/** Idempotent CDN loader. Loads only once per page. */
function loadPlayCanvasOnce(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('window not available'));
  }
  const win = window as unknown as { pc?: unknown };
  if (win.pc) return Promise.resolve();
  if (playCanvasPromise) return playCanvasPromise;

  playCanvasPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${PLAYCANVAS_CDN}"]`
    );
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('script error')));
      return;
    }
    const s = document.createElement('script');
    s.src = PLAYCANVAS_CDN;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load PlayCanvas from CDN'));
    document.head.appendChild(s);
  });
  return playCanvasPromise;
}
