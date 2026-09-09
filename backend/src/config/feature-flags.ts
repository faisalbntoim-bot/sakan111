/**
 * Feature flags — "Enter Property" (ادخل العقار) subsystem.
 *
 * ⚠️  All flags default to FALSE. Enabling any flag simply exposes a route
 *     or UI entry; it does NOT create infrastructure. In particular:
 *
 *     - PROPERTY_3D_CAPTURE_ENABLED does NOT provide a working 3D
 *       Gaussian Splatting pipeline — that requires an external GPU
 *       service which is not part of this repository.
 *     - PROPERTY_AR_ENABLED gates iOS AR entry points only.
 *
 * Reading env at module load is deliberate: the flags are static per
 * process, and tests can override by mutating `featureFlags` directly.
 */

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export interface FeatureFlags {
  PROPERTY_CAMERA_TEST_ENABLED: boolean;
  PROPERTY_3D_CAPTURE_ENABLED:  boolean;
  PROPERTY_3D_VIEWER_ENABLED:   boolean;
  PROPERTY_AR_ENABLED:          boolean;
}

export const featureFlags: FeatureFlags = {
  PROPERTY_CAMERA_TEST_ENABLED: parseBool(process.env.PROPERTY_CAMERA_TEST_ENABLED),
  PROPERTY_3D_CAPTURE_ENABLED:  parseBool(process.env.PROPERTY_3D_CAPTURE_ENABLED),
  PROPERTY_3D_VIEWER_ENABLED:   parseBool(process.env.PROPERTY_3D_VIEWER_ENABLED),
  PROPERTY_AR_ENABLED:          parseBool(process.env.PROPERTY_AR_ENABLED),
};

export function isFlagEnabled(name: keyof FeatureFlags): boolean {
  return featureFlags[name] === true;
}
