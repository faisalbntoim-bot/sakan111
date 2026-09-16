/**
 * LocalStorageProvider — production on-disk storage.
 *
 * Writes uploaded bytes directly to a configured directory on the
 * same server (no S3, no external cloud). Suitable for a single-node
 * deployment; for horizontal scale switch STORAGE_PROVIDER=s3.
 *
 * Contract (mirrors S3 provider):
 *   - Directory is PRIVATE; nothing under LOCAL_STORAGE_DIR is served
 *     by Nginx / a static file handler. Reads happen exclusively
 *     through the API's stream endpoint (GET /v1/media/:id/stream),
 *     which enforces auth + visibility rules and supports Range.
 *   - Every `signUpload()` returns an HMAC-signed URL of the form
 *
 *       /v1/media/local-upload/<providerKey>?exp=<ms>&sig=<hex>
 *
 *     which is short-lived (15 min) and bound to the exact key + exp
 *     + expected size. Verification in the route handler refuses any
 *     of: expired signature, wrong key, wrong size, missing/tampered
 *     signature. The client cannot ask for a different path.
 *   - Object keys (=> filesystem paths) are generated server-side and
 *     never contain user-supplied filenames. `verifyKey()` blocks any
 *     key that could path-traverse (`..`, absolute paths, backslashes).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  StorageProvider, SignedUploadRequest, SignedUploadResult, SignedDownloadResult,
} from './storage-provider.js';
import { assertUploadShape } from './storage-provider.js';

const UPLOAD_TTL_MS = 15 * 60 * 1000; // 15 min
const DEFAULT_DOWNLOAD_TTL_MS = 5 * 60 * 1000; // 5 min

export type LocalConfig = {
  dir: string;            // absolute directory root
  signingSecret: string;  // HMAC key (>= 32 chars)
};

/** Refuse anything that could escape the root. Called on every path resolution. */
export function verifyKey(providerKey: string): void {
  if (!providerKey || typeof providerKey !== 'string') throw new Error('empty providerKey');
  if (providerKey.length > 512) throw new Error('providerKey too long');
  // No absolute paths, no windows drive letters, no traversal segments,
  // no backslashes, no null bytes.
  if (providerKey.startsWith('/') || providerKey.startsWith('\\')) throw new Error('absolute path forbidden');
  if (/(^|\/)\.\.($|\/)/.test(providerKey)) throw new Error('path traversal forbidden');
  if (providerKey.includes('\\') || providerKey.includes('\0')) throw new Error('illegal character');
  // Only [A-Za-z0-9._/-] permitted (server generates keys — no reason for anything else).
  if (!/^[A-Za-z0-9._/-]+$/.test(providerKey)) throw new Error('illegal character');
}

function resolveDiskPath(root: string, providerKey: string): string {
  verifyKey(providerKey);
  const abs = path.resolve(root, providerKey);
  const rel = path.relative(root, abs);
  // Belt-and-braces: even after resolve, refuse anything that ends up outside root.
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path escapes root');
  return abs;
}

function signPayload(secret: string, providerKey: string, expMs: number, sizeBytes: number): string {
  return crypto.createHmac('sha256', secret)
    .update(`${providerKey}\n${expMs}\n${sizeBytes}`)
    .digest('hex');
}

export function makeSignedUploadUrl(cfg: LocalConfig, providerKey: string, sizeBytes: number, now = Date.now()): {
  url: string;
  expMs: number;
} {
  const expMs = now + UPLOAD_TTL_MS;
  const sig = signPayload(cfg.signingSecret, providerKey, expMs, sizeBytes);
  // Query string carries `size` too so the route can bind the signature
  // to the exact byte length. Encoded once — providerKey has already
  // been shape-restricted by verifyKey.
  const url = `/v1/media/local-upload/${providerKey}?exp=${expMs}&size=${sizeBytes}&sig=${sig}`;
  return { url, expMs };
}

/** Returns true iff (a) signature matches, (b) not expired, (c) size matches. */
export function verifySignedUpload(cfg: LocalConfig, providerKey: string, expMs: number, sizeBytes: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(expMs) || expMs <= now) return false;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return false;
  let expected: string;
  try { expected = signPayload(cfg.signingSecret, providerKey, expMs, sizeBytes); }
  catch { return false; }
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly cfg: LocalConfig;

  constructor(cfg: LocalConfig) {
    if (!cfg.dir || !path.isAbsolute(cfg.dir)) {
      throw new Error('LocalStorageProvider: dir must be an absolute path');
    }
    if (!cfg.signingSecret || cfg.signingSecret.length < 32) {
      throw new Error('LocalStorageProvider: signingSecret must be >= 32 chars');
    }
    this.cfg = cfg;
    // Ensure the root exists; ignore EEXIST (already there).
    try { fs.mkdirSync(cfg.dir, { recursive: true, mode: 0o750 }); } catch { /* ignore */ }
  }

  /** Public accessor so the route handler (and tests) can reach helpers. */
  get config(): LocalConfig { return this.cfg; }

  async signUpload(input: SignedUploadRequest): Promise<SignedUploadResult> {
    assertUploadShape(input);
    const assetId = crypto.randomBytes(12).toString('hex');
    const scope = input.visibility ?? 'private';
    const propSeg = input.propertyId ? `${input.propertyId}/` : '';
    const providerKey = `${scope}/${input.ownerUserId}/${propSeg}${assetId}`;
    verifyKey(providerKey);
    const { url, expMs } = makeSignedUploadUrl(this.cfg, providerKey, input.sizeBytes);
    return {
      assetId,
      provider: this.name,
      providerKey,
      uploadUrl: url,
      method: 'PUT',
      headers: {},
      expiresAt: new Date(expMs),
    };
  }

  async signDownload(providerKey: string, ttlSeconds = 300): Promise<SignedDownloadResult> {
    verifyKey(providerKey);
    // Local downloads go through the auth-guarded stream endpoint, not
    // a signed URL — return a stable relative reference so the client
    // just points its <img>/<video> at it.
    const ttl = Math.max(30, Math.min(60 * 60, ttlSeconds));
    return {
      assetId: providerKey.split('/').pop() ?? '',
      url: `/v1/media/local-stream/${providerKey}`,
      expiresAt: new Date(Date.now() + ttl * 1000),
    };
  }

  /** Called by the local-upload route after signature verification. */
  async writeBytes(providerKey: string, data: Buffer): Promise<void> {
    const abs = resolveDiskPath(this.cfg.dir, providerKey);
    await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o750 });
    await fsp.writeFile(abs, data, { mode: 0o640 });
  }

  /** Called by the stream route. Returns an fs.ReadStream and total size. */
  async openRead(providerKey: string, opts: { start?: number; end?: number } = {}): Promise<{ stream: fs.ReadStream; size: number }> {
    const abs = resolveDiskPath(this.cfg.dir, providerKey);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new Error('not a file');
    const stream = fs.createReadStream(abs, {
      start: opts.start,
      end: opts.end,
    });
    return { stream, size: stat.size };
  }

  async deleteObject(providerKey: string): Promise<void> {
    try {
      const abs = resolveDiskPath(this.cfg.dir, providerKey);
      await fsp.unlink(abs);
    } catch (e) {
      // Missing file is treated as success (idempotent).
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw e;
    }
  }
}
