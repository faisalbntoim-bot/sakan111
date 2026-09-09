/**
 * VirtualTourProvider — interface only.
 *
 * Represents any provider that can *serve* a virtual tour (panorama_360,
 * gaussian_splat playback, virtual walkthrough). No provider is wired in;
 * the default `LocalTourProvider` simply resolves against MediaAsset via
 * the existing storage-signed-URL flow — good enough for panorama_360
 * where the client (iOS SceneKit / web PlayCanvas) plays the file
 * directly, but honestly reports "no viewer configured" for 3DGS types
 * until the client viewer is enabled by feature flag.
 */

export type TourType = 'panorama_360' | 'gaussian_splat' | 'virtual_walkthrough' | 'ai_tour';

export interface TourManifest {
  tourId: string;
  tourType: TourType;
  primaryAssetSignedUrl: string | null;
  message?: string;
}

export interface VirtualTourProvider {
  readonly name: string;
  buildManifest(input: {
    tourId: string;
    tourType: TourType;
    primaryAssetId: string | null;
    ownerUserId: string;
  }): Promise<TourManifest>;
}
