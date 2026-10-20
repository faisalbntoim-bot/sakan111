/**
 * SandboxStorageProvider — dev/test store that persists bytes in memory.
 *
 * Three-tier layout mirroring how the production storage prevents
 * post-verify byte substitution:
 *   uploads/<owner>/<assetId>            ← signed PUT lands here
 *   verifying/<attemptUuid>-<assetId>    ← attempt-scoped quarantine
 *   finalized/<owner>/<assetId>          ← MediaAsset.providerKey
 *
 * `stage(uploads, verifying)` and `publish(verifying, finalized)` are
 * both atomic Map operations here; on local/S3 they map to fs.rename
 * and CopyObject respectively. The critical property is: after `stage()`
 * returns, no signed PUT URL the client holds can reach the file being
 * verified.
 */

import crypto from 'node:crypto';
import type {
  StorageProvider, SignedUploadRequest, SignedUploadResult, SignedDownloadResult,
  StoredObjectStat,
} from './storage-provider.js';
import { assertUploadShape } from './storage-provider.js';
import { detectContentType } from './detect.js';

const _objects = new Map<string, Buffer>();

export function _sandboxWrite(providerKey: string, bytes: Buffer): void {
  _objects.set(providerKey, bytes);
}
export function _sandboxHas(providerKey: string): boolean {
  return _objects.has(providerKey);
}
export function _sandboxGet(providerKey: string): Buffer | undefined {
  return _objects.get(providerKey);
}
export function _sandboxReset(): void {
  _objects.clear();
}

/** `uploads/…` → `finalized/…`. Kept for use by callers that want to
 *  compute the final key at sign-response time (media route uses it). */
export function stagingToFinalKey(stagingKey: string): string {
  if (!stagingKey.startsWith('uploads/')) {
    throw new Error(`not a staging key: ${stagingKey}`);
  }
  return 'finalized/' + stagingKey.slice('uploads/'.length);
}

export class SandboxStorageProvider implements StorageProvider {
  readonly name = 'sandbox';

  async signUpload(input: SignedUploadRequest): Promise<SignedUploadResult> {
    assertUploadShape(input);
    const assetId = crypto.randomBytes(8).toString('hex');
    const providerKey = `uploads/${input.ownerUserId}/${assetId}`;
    return {
      assetId,
      provider: this.name,
      providerKey,
      uploadUrl: `sandbox://upload/${providerKey}?ct=${encodeURIComponent(input.contentType)}`,
      method: 'PUT',
      headers: { 'x-amz-checksum-sha256': input.sha256 },
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };
  }

  async signDownload(providerKey: string, ttlSeconds = 300): Promise<SignedDownloadResult> {
    return {
      assetId: providerKey.split('/').pop() ?? '',
      url: `sandbox://download/${providerKey}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  async head(providerKey: string): Promise<StoredObjectStat> {
    const bytes = _objects.get(providerKey);
    if (!bytes) throw new Error('NOT_FOUND');
    const head = bytes.subarray(0, 64);
    return {
      sizeBytes: bytes.length,
      detectedContentType: detectContentType(head),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }

  /** Atomic uploads → verifying. Only one attempt succeeds on a given key. */
  async stage(stagingKey: string, verifyingKey: string): Promise<void> {
    const bytes = _objects.get(stagingKey);
    if (!bytes) throw new Error('NOT_FOUND');
    if (_objects.has(verifyingKey)) throw new Error('ALREADY_STAGED');
    _objects.set(verifyingKey, bytes);
    _objects.delete(stagingKey);
  }

  /** Idempotent delete of a verifying/… key. */
  async unstage(verifyingKey: string): Promise<void> {
    _objects.delete(verifyingKey);
  }

  /** Atomic verifying → finalized. Refuses overwrite. */
  async publish(verifyingKey: string, finalKey: string): Promise<void> {
    if (verifyingKey === finalKey) return;
    const bytes = _objects.get(verifyingKey);
    if (!bytes) throw new Error('NOT_FOUND');
    if (_objects.has(finalKey)) throw new Error('ALREADY_PUBLISHED');
    _objects.set(finalKey, bytes);
    _objects.delete(verifyingKey);
  }
}
