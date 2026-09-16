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
    expect(signed.providerKey.startsWith('private/user_1/prop_1/')).toBe(true);
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
