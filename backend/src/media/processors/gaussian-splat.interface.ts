/**
 * GaussianSplatProcessor — interface only.
 *
 * ⚠️  There is NO real 3D Gaussian Splatting pipeline in this repository.
 *     A production implementation requires:
 *       - GPU compute (NVIDIA A10/A100 class or better)
 *       - COLMAP for structure-from-motion camera-pose estimation
 *       - gsplat / nerfstudio / postshot for training the splat scene
 *       - SuperSplat / SOG for compression to a viewer-friendly format
 *
 *     Delivering any of that is outside this repo's scope. The default
 *     `UnavailableGaussianSplatProcessor` returns `not_available` for every
 *     call so downstream code (routes, iOS, web) can honestly report
 *     "processing service is not configured" instead of pretending to work.
 *
 * When a real service is added, implement this interface in a new file
 * (e.g. `postshot.processor.ts`) and swap the export in `index.ts`.
 */

export type SplatInputFormat  = 'photo_burst' | 'video_walkthrough';
export type SplatOutputFormat = 'ply' | 'splat' | 'sog';

export interface SplatSubmitInput {
  ownerUserId: string;
  mediaAssetIds: string[];      // input photos/videos already stored via MediaAsset
  outputFormat?: SplatOutputFormat;
  /** Optional client-supplied hint about the scene (indoor/outdoor/room). */
  sceneHint?: string;
}

export interface SplatJobStatus {
  providerJobId: string | null;
  state: 'not_available' | 'queued' | 'processing' | 'ready' | 'failed';
  outputAssetKey?: string;      // provider storage key of the produced splat
  message?: string;             // human-readable — surfaced to the client verbatim
}

export interface GaussianSplatProcessor {
  readonly name: string;
  submit(input: SplatSubmitInput): Promise<SplatJobStatus>;
  poll(providerJobId: string): Promise<SplatJobStatus>;
}

/**
 * Default processor — no external service configured. Always reports
 * `not_available` with a clear message. NEVER returns a fake "ready".
 */
export class UnavailableGaussianSplatProcessor implements GaussianSplatProcessor {
  readonly name = 'unavailable';

  async submit(_input: SplatSubmitInput): Promise<SplatJobStatus> {
    return {
      providerJobId: null,
      state: 'not_available',
      message: '3D Gaussian Splatting processing service is not configured on this deployment. This is not a bug — it is a deliberate honest response until a real GPU pipeline is wired in.',
    };
  }

  async poll(_providerJobId: string): Promise<SplatJobStatus> {
    return {
      providerJobId: _providerJobId,
      state: 'not_available',
      message: '3D Gaussian Splatting processing service is not configured on this deployment.',
    };
  }
}

let processor: GaussianSplatProcessor = new UnavailableGaussianSplatProcessor();

export function getGaussianSplatProcessor(): GaussianSplatProcessor {
  return processor;
}

/** For tests / future real implementations. */
export function setGaussianSplatProcessor(next: GaussianSplatProcessor): void {
  processor = next;
}
