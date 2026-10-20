/**
 * LocalStorageProvider — coverage.
 *
 * All tests run against a per-suite temp directory. No cloud contact.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalStorageProvider, makeSignedUploadUrl, verifySignedUpload, verifyKey } from '../src/storage/local.js';

const SECRET = 'x'.repeat(48);
let DIR = '';

beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-local-storage-'));
});
afterAll(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---- Constructor + verifyKey --------------------------------------

describe('LocalStorageProvider construction', () => {
  it('refuses a non-absolute dir', () => {
    expect(() => new LocalStorageProvider({ dir: 'relative/dir', signingSecret: SECRET })).toThrow();
  });
  it('refuses a short signing secret', () => {
    expect(() => new LocalStorageProvider({ dir: DIR, signingSecret: 'short' })).toThrow();
  });
});

describe('verifyKey — path traversal defence', () => {
  it('accepts a normal server-generated key', () => {
    expect(() => verifyKey('private/user_1/prop_2/abcdef')).not.toThrow();
  });
  it('refuses `..` segments', () => {
    expect(() => verifyKey('private/../etc/passwd')).toThrow();
    expect(() => verifyKey('..')).toThrow();
    expect(() => verifyKey('a/../b')).toThrow();
  });
  it('refuses absolute paths', () => {
    expect(() => verifyKey('/etc/passwd')).toThrow();
  });
  it('refuses backslashes and null bytes', () => {
    expect(() => verifyKey('private\\user_1\\x')).toThrow();
    expect(() => verifyKey('private/x\0evil')).toThrow();
  });
  it('refuses characters outside the strict allowlist', () => {
    expect(() => verifyKey('private/user 1/x')).toThrow();
    expect(() => verifyKey('private/user_1/x?y')).toThrow();
    expect(() => verifyKey('private/user_1/x*y')).toThrow();
  });
});

// ---- Signature sign / verify --------------------------------------

describe('signed upload URL', () => {
  const cfg = () => ({ dir: DIR, signingSecret: SECRET });

  it('a fresh signature verifies', () => {
    const { url } = makeSignedUploadUrl(cfg(), 'private/u/asset_1', 1024);
    const u = new URL('http://x' + url);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig') ?? '';
    expect(verifySignedUpload(cfg(), 'private/u/asset_1', exp, 1024, sig)).toBe(true);
  });

  it('a tampered signature is rejected', () => {
    const { url } = makeSignedUploadUrl(cfg(), 'private/u/asset_1', 1024);
    const u = new URL('http://x' + url);
    const exp = Number(u.searchParams.get('exp'));
    const bad = 'f'.repeat(64);
    expect(verifySignedUpload(cfg(), 'private/u/asset_1', exp, 1024, bad)).toBe(false);
  });

  it('a signature for a different key is rejected', () => {
    const { url } = makeSignedUploadUrl(cfg(), 'private/u/asset_A', 1024);
    const u = new URL('http://x' + url);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig') ?? '';
    expect(verifySignedUpload(cfg(), 'private/u/asset_B', exp, 1024, sig)).toBe(false);
  });

  it('a signature for a different size is rejected', () => {
    const { url } = makeSignedUploadUrl(cfg(), 'private/u/asset_1', 1024);
    const u = new URL('http://x' + url);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig') ?? '';
    expect(verifySignedUpload(cfg(), 'private/u/asset_1', exp, 2048, sig)).toBe(false);
  });

  it('an expired signature is rejected', () => {
    // Back-date the URL far enough that even after the +15min TTL it is
    // still in the past by the time we verify.
    const pastNow = Date.now() - 60 * 60 * 1000; // 1 h ago
    const { url } = makeSignedUploadUrl(cfg(), 'private/u/asset_1', 1024, pastNow);
    const u = new URL('http://x' + url);
    const exp = Number(u.searchParams.get('exp'));
    const sig = u.searchParams.get('sig') ?? '';
    expect(exp).toBeLessThan(Date.now()); // sanity
    expect(verifySignedUpload(cfg(), 'private/u/asset_1', exp, 1024, sig)).toBe(false);
  });

  it('a malformed signature (non-hex / wrong length) is rejected', () => {
    expect(verifySignedUpload(cfg(), 'k', Date.now() + 60_000, 1, 'not-hex')).toBe(false);
    expect(verifySignedUpload(cfg(), 'k', Date.now() + 60_000, 1, '')).toBe(false);
  });
});

// ---- signUpload / writeBytes / openRead / deleteObject ------------

describe('write + read + delete round-trip', () => {
  it('signs, writes, streams back, and deletes a file', async () => {
    const p = new LocalStorageProvider({ dir: DIR, signingSecret: SECRET });
    const signed = await p.signUpload({
      ownerUserId: 'user_1', propertyId: 'prop_1',
      kind: 'image', contentType: 'image/jpeg',
      sizeBytes: 4, sha256: '0'.repeat(64), visibility: 'private',
    });
    expect(signed.providerKey.startsWith('uploads/private/user_1/property/prop_1/')).toBe(true);
    expect(signed.uploadUrl.startsWith('/v1/media/local-upload/')).toBe(true);

    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic
    await p.writeBytes(signed.providerKey, bytes);

    const { stream, size } = await p.openRead(signed.providerKey);
    expect(size).toBe(4);
    // Drain the stream and confirm bytes.
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);

    await p.deleteObject(signed.providerKey);
    await expect(p.openRead(signed.providerKey)).rejects.toBeTruthy();
    // Second delete is idempotent.
    await p.deleteObject(signed.providerKey);
  });

  it('openRead honours a partial byte range', async () => {
    const p = new LocalStorageProvider({ dir: DIR, signingSecret: SECRET });
    const signed = await p.signUpload({
      ownerUserId: 'user_2', kind: 'video', contentType: 'video/webm',
      sizeBytes: 10, sha256: '0'.repeat(64), visibility: 'private',
    });
    const bytes = Buffer.from('0123456789');
    await p.writeBytes(signed.providerKey, bytes);
    const { stream } = await p.openRead(signed.providerKey, { start: 4, end: 7 });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe('4567');
  });

  it('writeBytes refuses a traversal key', async () => {
    const p = new LocalStorageProvider({ dir: DIR, signingSecret: SECRET });
    await expect(p.writeBytes('../etc/passwd', Buffer.from('x'))).rejects.toThrow();
  });
});

// ---- V5: TOCTOU with a pre-existing writer fd -------------------------
//
// The reviewer proved v4's stage() (fsp.link + unlink) leaves the verifying
// object pointing at the SAME inode a caller's file descriptor is still
// holding — subsequent writes via that fd leak into the quarantine. v5
// switches stage() to fs.copyFile so verifying/ gets a FRESH inode. This
// test reproduces the reviewer's scenario against the real filesystem.

import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

function sha256Buf(b: Buffer): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}

describe('LocalStorageProvider.stage — isolates pre-existing writer', () => {
  it('a write fd opened BEFORE stage cannot mutate what publish moves', async () => {
    const p = new LocalStorageProvider({ dir: DIR, signingSecret: SECRET });
    const A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]); // 22 bytes JPEG
    const B = Buffer.from(A); B[10] = (A[10]! ^ 0xff) & 0xff; // 22 bytes, different

    const stagingKey  = 'uploads/user_x/toctou_test_A1B2';
    const verifyingKey = 'verifying/toctou-attempt-uuid-X-toctou_test_A1B2';
    const finalKey    = 'finalized/user_x/toctou_test_A1B2';

    // 1. Server writes A.
    await p.writeBytes(stagingKey, A);
    const stagingPath = path.join(DIR, stagingKey);

    // 2. A concurrent "PUT in flight" opens a WRITE handle to uploads/…
    //    BEFORE stage runs. This mimics the reviewer's manual reproduction.
    const fh = await fsp.open(stagingPath, 'r+');

    try {
      // 3. Server stages the file — v4 used hard link (same inode), v5
      //    uses copyFile (fresh inode).
      await p.stage(stagingKey, verifyingKey);

      // 4. HEAD returns A's stats.
      const stat = await p.head(verifyingKey);
      expect(stat.sizeBytes).toBe(A.length);
      expect(stat.sha256).toBe(sha256Buf(A));

      // 5. Attacker writes B via the OLD fd. On v4 this would corrupt the
      //    verifying file; on v5 it hits the orphaned original inode.
      await fh.write(B, 0, B.length, 0);
      await fh.sync();

      // 6. Publish verifying → finalized.
      await p.publish(verifyingKey, finalKey);

      // 7. HEAD finalized. Bytes MUST match A, not B — this is the assertion
      //    the reviewer said v4 fails. v5 must pass.
      const finalStat = await p.head(finalKey);
      expect(finalStat.sizeBytes).toBe(A.length);
      expect(finalStat.sha256).toBe(sha256Buf(A));
      expect(finalStat.sha256).not.toBe(sha256Buf(B));

      // 8. Read the finalized bytes back and compare — file-bytes level,
      //    not just DB fields.
      const finalPath = path.join(DIR, finalKey);
      const finalBytes = await fsp.readFile(finalPath);
      expect(Buffer.compare(finalBytes, A)).toBe(0);
    } finally {
      await fh.close();
      await p.unstage(finalKey).catch(() => {});
      await fsp.rm(path.join(DIR, 'uploads'), { recursive: true, force: true }).catch(() => {});
      await fsp.rm(path.join(DIR, 'verifying'), { recursive: true, force: true }).catch(() => {});
      await fsp.rm(path.join(DIR, 'finalized'), { recursive: true, force: true }).catch(() => {});
    }
  });

  it('writeBytes uses temp+atomic-rename so a pre-existing read fd sees the OLD inode after a re-upload', async () => {
    // Extra: an attacker holding a read fd on uploads/ during a re-upload
    // must not see the new bytes. v5 writeBytes uses temp+rename so the
    // reader's fd points at the old (now orphaned) inode.
    const p = new LocalStorageProvider({ dir: DIR, signingSecret: SECRET });
    const A = Buffer.from('AAAAAAAA');
    const B = Buffer.from('BBBBBBBB');
    const key = 'uploads/user_y/rename_test';
    await p.writeBytes(key, A);
    const abs = path.join(DIR, key);
    const fh = await fsp.open(abs, 'r');
    try {
      // Read via the OLD fd should see A.
      const buf1 = Buffer.alloc(A.length);
      await fh.read(buf1, 0, A.length, 0);
      expect(Buffer.compare(buf1, A)).toBe(0);
      // Server re-writes B via atomic replace.
      await p.writeBytes(key, B);
      // Fresh open sees B.
      expect(Buffer.compare(await fsp.readFile(abs), B)).toBe(0);
      // OLD fd still sees A (orphan inode).
      const buf2 = Buffer.alloc(A.length);
      await fh.read(buf2, 0, A.length, 0);
      expect(Buffer.compare(buf2, A)).toBe(0);
    } finally {
      await fh.close();
      await fsp.rm(path.join(DIR, 'uploads'), { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('LocalStorageProvider — DB-failure recovery leaves bytes at finalKey (not verifying)', () => {
  it('after a successful publish, a subsequent finalize attempt can locate bytes at finalKey', async () => {
    // The route removed rollbackPublish for exactly this reason: leaving
    // bytes at finalKey means completeAtFinalKey() (route-level recovery)
    // can pick them up on retry without a re-upload.
    const p = new LocalStorageProvider({ dir: DIR, signingSecret: SECRET });
    const A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const stagingKey  = 'uploads/user_r/db_fail_test';
    const verifyingKey = 'verifying/db-fail-attempt-uuid-Y-db_fail_test';
    const finalKey    = 'finalized/user_r/db_fail_test';
    await p.writeBytes(stagingKey, A);
    await p.stage(stagingKey, verifyingKey);
    await p.publish(verifyingKey, finalKey);
    // Simulate DB failure: no rollback (v5 removed it). Retry sees:
    // - uploads: NOT_FOUND
    // - verifying: NOT_FOUND (moved by publish)
    // - finalized: EXISTS with the verified bytes
    await expect(p.head('uploads/user_r/db_fail_test')).rejects.toThrow(/NOT_FOUND/);
    await expect(p.head(verifyingKey)).rejects.toThrow(/NOT_FOUND/);
    const stat = await p.head(finalKey);
    expect(stat.sha256).toBe(sha256Buf(A));
    // Cleanup
    await fsp.rm(path.join(DIR, 'uploads'), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.join(DIR, 'verifying'), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.join(DIR, 'finalized'), { recursive: true, force: true }).catch(() => {});
  });
});

// ---- V6: signed download URL (HMAC, no Bearer required) ---------------

import { makeSignedDownloadUrl, verifySignedDownload } from '../src/storage/local.js';

describe('LocalStorageProvider — signed download URLs', () => {
  it('mints a URL that verifies with the same secret', () => {
    const cfg = { dir: DIR, signingSecret: SECRET };
    const { url, expMs } = makeSignedDownloadUrl(cfg, 'finalized/user_a/asset123', 300);
    expect(url).toMatch(/^\/v1\/media\/local-stream\/finalized\/user_a\/asset123\?exp=\d+&sig=[a-f0-9]{64}$/);
    const sig = url.split('sig=')[1]!;
    expect(verifySignedDownload(cfg, 'finalized/user_a/asset123', expMs, sig)).toBe(true);
  });
  it('refuses an expired signature', () => {
    const cfg = { dir: DIR, signingSecret: SECRET };
    const pastNow = Date.now() - 3600_000;
    const { url, expMs } = makeSignedDownloadUrl(cfg, 'finalized/user_a/asset123', 300, pastNow);
    const sig = url.split('sig=')[1]!;
    expect(verifySignedDownload(cfg, 'finalized/user_a/asset123', expMs, sig)).toBe(false);
  });
  it('refuses a tampered providerKey', () => {
    const cfg = { dir: DIR, signingSecret: SECRET };
    const { url, expMs } = makeSignedDownloadUrl(cfg, 'finalized/user_a/asset123', 300);
    const sig = url.split('sig=')[1]!;
    expect(verifySignedDownload(cfg, 'finalized/user_b/asset999', expMs, sig)).toBe(false);
  });
  it('refuses a signature signed with a different secret', () => {
    const cfg1 = { dir: DIR, signingSecret: SECRET };
    const cfg2 = { dir: DIR, signingSecret: 'y'.repeat(48) };
    const { url, expMs } = makeSignedDownloadUrl(cfg1, 'finalized/user_a/asset123', 300);
    const sig = url.split('sig=')[1]!;
    expect(verifySignedDownload(cfg2, 'finalized/user_a/asset123', expMs, sig)).toBe(false);
  });
  it('upload signature cannot be replayed as a download signature (separate HMAC namespace)', () => {
    // Cross-purpose defence: an upload sig verifies with `${providerKey}\n${exp}\n${size}` while
    // download verifies with `download\n${providerKey}\n${exp}`. A stolen upload sig
    // must NOT authorise a read.
    const cfg = { dir: DIR, signingSecret: SECRET };
    const { url: uploadUrl, expMs } = makeSignedUploadUrl(cfg, 'uploads/user_a/asset1', 100);
    const uploadSig = uploadUrl.match(/sig=([a-f0-9]{64})$/)![1]!;
    expect(verifySignedDownload(cfg, 'uploads/user_a/asset1', expMs, uploadSig)).toBe(false);
  });
});
