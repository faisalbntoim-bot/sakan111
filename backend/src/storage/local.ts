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
  StoredObjectStat,
} from './storage-provider.js';
import { assertUploadShape } from './storage-provider.js';
import { detectContentType } from './detect.js';

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

/** HMAC binding for a download URL. Separate namespace from uploads so a
 *  compromised signing pipeline cannot cross-purpose (e.g., using a
 *  download signature to authorise a write). Bound to providerKey + exp.
 *  No `size` binding here because readers only need to prove they were
 *  handed the URL by an authenticated caller — they aren't declaring
 *  anything about the bytes. */
function signDownloadPayload(secret: string, providerKey: string, expMs: number): string {
  return crypto.createHmac('sha256', secret)
    .update(`download\n${providerKey}\n${expMs}`)
    .digest('hex');
}
export function makeSignedDownloadUrl(cfg: LocalConfig, providerKey: string, ttlSeconds: number, now = Date.now()): { url: string; expMs: number } {
  const ttl = Math.max(30, Math.min(60 * 60, ttlSeconds));
  const expMs = now + ttl * 1000;
  const sig = signDownloadPayload(cfg.signingSecret, providerKey, expMs);
  const url = `/v1/media/local-stream/${providerKey}?exp=${expMs}&sig=${sig}`;
  return { url, expMs };
}
export function verifySignedDownload(cfg: LocalConfig, providerKey: string, expMs: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(expMs) || expMs <= now) return false;
  let expected: string;
  try { expected = signDownloadPayload(cfg.signingSecret, providerKey, expMs); }
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
    const propSeg = input.propertyId ? `property/${input.propertyId}/` : '';
    // Staging tier — the signed PUT URL can only target `uploads/…`. The
    // finalize route calls `publish()` after verification to rename bytes
    // into `finalized/…`, which the reader endpoint alone can address.
    // A racing PUT with the still-valid signed URL therefore cannot mutate
    // what MediaAsset serves.
    const providerKey = `uploads/${scope}/${input.ownerUserId}/${propSeg}${assetId}`;
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
    // HMAC-signed URL so browser <video>/<img> tags can fetch bytes WITHOUT
    // sending a session Bearer (they can't add custom headers). The signature
    // is per-object + per-expiry; anyone with the URL can read for TTL, so
    // the calling route (GET /v1/media/:id/url) MUST have already checked
    // ownership + visibility before minting the URL. Reviewer explicitly
    // vetoed putting session JWTs in URLs.
    const { url, expMs } = makeSignedDownloadUrl(this.cfg, providerKey, ttlSeconds);
    return {
      assetId: providerKey.split('/').pop() ?? '',
      url,
      expiresAt: new Date(expMs),
    };
  }

  /** Called by the local-upload route after signature verification.
   *  Writes to a unique temp file then atomically renames onto the target
   *  path — this guarantees the published file always has a FRESH inode,
   *  so any file descriptor a caller opened before writeBytes ran points
   *  to an unrelated (now-orphaned) inode and cannot mutate our bytes.
   *  A subsequent stage() copyFile creates yet another fresh inode. */
  async writeBytes(providerKey: string, data: Buffer): Promise<void> {
    const abs = resolveDiskPath(this.cfg.dir, providerKey);
    await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o750 });
    const tmp = `${abs}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    await fsp.writeFile(tmp, data, { mode: 0o640 });
    await fsp.rename(tmp, abs);
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

  /** Live stat + SHA-256 + magic-byte content-type check for /v1/media
   *  finalize. Throws `NOT_FOUND` (message) when the object is missing so
   *  the route can render a clean 404. Full-file hashing is acceptable for
   *  the current per-file caps (≤ 15 MB images, ≤ 300 MB videos). */
  async head(providerKey: string): Promise<StoredObjectStat> {
    const abs = resolveDiskPath(this.cfg.dir, providerKey);
    let stat;
    try { stat = await fsp.stat(abs); }
    catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') throw new Error('NOT_FOUND');
      throw e;
    }
    if (!stat.isFile()) throw new Error('NOT_FOUND');
    // Read the first 64 bytes for magic-byte detection …
    const fh = await fsp.open(abs, 'r');
    let head: Buffer;
    try {
      head = Buffer.alloc(Math.min(64, stat.size));
      await fh.read(head, 0, head.length, 0);
    } finally { await fh.close(); }
    // … then stream through SHA-256. Streaming avoids loading the whole
    // file into memory for large videos.
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const s = fs.createReadStream(abs);
      s.on('data', (chunk) => hash.update(chunk));
      s.on('end', resolve);
      s.on('error', reject);
    });
    return {
      sizeBytes: stat.size,
      detectedContentType: detectContentType(head),
      sha256: hash.digest('hex'),
    };
  }

  /** Best-effort write-once seal: chmod the file to 0o440 so a subsequent
   *  PUT (which fs.writeFile does not honour anyway once the mode is
   *  read-only for the process user) cannot overwrite it. */
  async seal(providerKey: string): Promise<void> {
    try {
      const abs = resolveDiskPath(this.cfg.dir, providerKey);
      await fsp.chmod(abs, 0o440);
    } catch { /* best-effort */ }
  }

  /** Atomically snapshot `uploads/…` bytes into an attempt-scoped quarantine
   *  location that no file handle opened before this call can reach.
   *
   *  copyFile ALONE isn't enough: it can leave a partial file at the
   *  destination if we crash mid-copy, which a subsequent finalize would
   *  then see as an "already staged" file and (via completeAtFinalKey)
   *  correctly reject on hash mismatch — but that's a wasted round-trip.
   *  Better: copy to a per-attempt tmp path, then `fsp.link` atomically
   *  publishes the tmp file at the verifying key. link fails EEXIST if
   *  someone else finished the race first, so we never overwrite.
   *
   *  The source is unlinked at the end, leaving any lingering writer's fd
   *  pointing at an orphaned inode. */
  async stage(stagingKey: string, verifyingKey: string): Promise<void> {
    verifyKey(stagingKey); verifyKey(verifyingKey);
    const from = resolveDiskPath(this.cfg.dir, stagingKey);
    const to   = resolveDiskPath(this.cfg.dir, verifyingKey);
    await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o750 });
    const tmp = `${to}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    try {
      await fsp.copyFile(from, tmp);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') throw new Error('NOT_FOUND');
      throw e;
    }
    try {
      await fsp.link(tmp, to);
    } catch (e) {
      // Clean up the tmp we no longer need.
      await fsp.unlink(tmp).catch(() => {});
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') throw new Error('ALREADY_STAGED');
      throw e;
    }
    // At this point `to` is fully populated (link is atomic). Drop the tmp
    // name and the source.
    await fsp.unlink(tmp).catch(() => {});
    try { await fsp.chmod(to, 0o440); } catch { /* best-effort */ }
    try { await fsp.unlink(from); } catch { /* best-effort */ }
  }

  /** Idempotent delete of a verifying/… object. */
  async unstage(verifyingKey: string): Promise<void> {
    try {
      verifyKey(verifyingKey);
      const abs = resolveDiskPath(this.cfg.dir, verifyingKey);
      await fsp.unlink(abs);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw e;
    }
  }

  /** Atomically move `verifying/…` → `finalized/…` and chmod to 0o440.
   *  Copies to a per-attempt tmp path then hard-links the finalized name
   *  onto it. `link` is atomic — either the destination is the complete
   *  copy or it does not exist. A reader that hits finalKey never sees a
   *  partial file. EEXIST at link time surfaces as ALREADY_PUBLISHED so
   *  the finalize route can consult completeAtFinalKey() to verify. */
  async publish(verifyingKey: string, finalKey: string): Promise<void> {
    if (verifyingKey === finalKey) return;
    verifyKey(verifyingKey); verifyKey(finalKey);
    const from = resolveDiskPath(this.cfg.dir, verifyingKey);
    const to   = resolveDiskPath(this.cfg.dir, finalKey);
    await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o750 });
    const tmp = `${to}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    try {
      await fsp.copyFile(from, tmp);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') throw new Error('NOT_FOUND');
      throw e;
    }
    try {
      await fsp.link(tmp, to);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') throw new Error('ALREADY_PUBLISHED');
      throw e;
    }
    await fsp.unlink(tmp).catch(() => {});
    try { await fsp.chmod(to, 0o440); } catch { /* best-effort */ }
    try { await fsp.unlink(from); } catch { /* best-effort */ }
  }

  /** Reverse of publish — used by finalize when the DB commit fails.
   *  Best-effort: recreates the verifying entry from the final one and
   *  removes final. Guarantees the retry sees a consistent tier layout. */
  async rollbackPublish(finalKey: string, verifyingKey: string): Promise<void> {
    verifyKey(finalKey); verifyKey(verifyingKey);
    const from = resolveDiskPath(this.cfg.dir, finalKey);
    const to   = resolveDiskPath(this.cfg.dir, verifyingKey);
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o750 });
      await fsp.chmod(from, 0o640); // restore writable bit before link
      await fsp.link(from, to);
      try { await fsp.unlink(from); } catch { /* orphan final harmless */ }
    } catch { /* best-effort */ }
  }
}
