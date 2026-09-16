/**
 * Storage provider factory.
 *
 * Selects the concrete provider from the `STORAGE_PROVIDER` env slot:
 *   - `sandbox` (dev + tests): in-memory URLs, no bytes persisted.
 *   - `s3`      (production):  real SigV4-presigned PUT / GET URLs.
 *
 * The choice is honoured at process boot, but `_setStorage()` lets
 * tests inject a specific instance without touching the env.
 */

import { config } from '../config.js';
import { SandboxStorageProvider } from './sandbox.js';
import { S3StorageProvider, type S3Config } from './s3.js';
import type { StorageProvider } from './storage-provider.js';

let cached: StorageProvider | null = null;

function buildFromEnv(): StorageProvider {
  if (config.STORAGE_PROVIDER === 's3') {
    const s3cfg: S3Config = {
      bucket: config.S3_BUCKET!,
      region: config.S3_REGION!,
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      publicBaseUrl: config.S3_PUBLIC_BASE_URL,
    };
    return new S3StorageProvider(s3cfg);
  }
  return new SandboxStorageProvider();
}

export function getStorage(): StorageProvider {
  if (cached) return cached;
  cached = buildFromEnv();
  return cached;
}

/** Test hook — replace the storage provider. Passing null re-evaluates from env on next call. */
export function _setStorage(p: StorageProvider | null) { cached = p; }
