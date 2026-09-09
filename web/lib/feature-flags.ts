/**
 * Feature flags for the SakanHub marketing site's optional
 * "Enter Property" viewer surface.
 *
 * All flags DEFAULT to OFF. Reading from `NEXT_PUBLIC_*` env vars means
 * a build step (in Vercel or locally) enables them; there is no
 * runtime UI to toggle them, and no server round-trip.
 *
 * Notes:
 *   - `NEXT_PUBLIC_PROPERTY_3D_VIEWER_ENABLED` gates the PlayCanvas
 *     viewer entry point. When off, `<PlayCanvasViewer />` renders
 *     nothing so it can be safely dropped anywhere.
 *   - There is NO real 3D processing pipeline in this deployment; the
 *     viewer expects a pre-baked `.splat` / `.ply` URL served from a
 *     cloud pipeline that isn't part of this repo.
 */

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export const webFeatureFlags = {
  PROPERTY_3D_VIEWER_ENABLED: parseBool(process.env.NEXT_PUBLIC_PROPERTY_3D_VIEWER_ENABLED),
  PROPERTY_AR_ENABLED:        parseBool(process.env.NEXT_PUBLIC_PROPERTY_AR_ENABLED),
} as const;

export type WebFeatureFlags = typeof webFeatureFlags;
