/**
 * S3StorageProvider — real signed-URL storage.
 *
 * Implements AWS Signature Version 4 presigned URLs with `node:crypto`
 * only — no external SDK is added. Works against:
 *
 *   - Amazon S3 (default; virtual-hosted-style: <bucket>.s3.<region>.amazonaws.com)
 *   - Cloudflare R2, DigitalOcean Spaces, MinIO, any S3-compatible
 *     store — set S3_ENDPOINT and (if the service requires it)
 *     S3_FORCE_PATH_STYLE=true.
 *
 * Contract:
 *   - Bucket is expected to be PRIVATE. Every read goes through a
 *     short-lived signed GET; every write goes through a short-lived
 *     signed PUT that the browser hits directly. No file byte ever
 *     transits this server, no bucket is public.
 *   - Object keys are generated server-side. The client cannot pick
 *     its own file name or path.
 *   - CORS on the bucket must allow the Sakan Hub web origin(s) with
 *     methods PUT + GET + HEAD and the request headers used by the
 *     browser (content-type at minimum). Configuring CORS is an
 *     operator responsibility — the provider only signs URLs.
 *
 * Signing details:
 *   - SigV4 with SignedHeaders=host and UNSIGNED-PAYLOAD, so the
 *     browser is free to set its own Content-Type on the PUT.
 *   - X-Amz-Expires window comes from the SIGN_TTL constants below.
 *   - GET URLs may be routed through S3_PUBLIC_BASE_URL when set, so
 *     a CDN in front of the bucket can serve the images while the
 *     signature remains valid.
 */

import crypto from 'node:crypto';
import type {
  StorageProvider, SignedUploadRequest, SignedUploadResult, SignedDownloadResult,
  StoredObjectStat,
} from './storage-provider.js';
import { assertUploadShape } from './storage-provider.js';

// TTLs — the client only ever needs a brief window to PUT / GET.
const UPLOAD_TTL_SECONDS = 15 * 60; // 15 min
const DEFAULT_DOWNLOAD_TTL_SECONDS = 5 * 60; // 5 min
const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

export type S3Config = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional custom endpoint (Cloudflare R2, MinIO, DO Spaces). */
  endpoint?: string;
  /** MinIO and some proxies require path-style; AWS + R2 default to virtual-hosted. */
  forcePathStyle?: boolean;
  /** Optional CDN base for signed GET URLs (e.g. https://cdn.example.com). */
  publicBaseUrl?: string;
};

function hmac(key: crypto.BinaryLike | crypto.KeyObject, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function sha256Hex(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
/** RFC 3986 encoding, per SigV4 spec (single-encoded — slashes stay in paths). */
function uriEncode(input: string, encodeSlash: boolean): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    const code = input.charCodeAt(i);
    const isUnreserved =
      (code >= 0x30 && code <= 0x39) ||        // 0-9
      (code >= 0x41 && code <= 0x5a) ||        // A-Z
      (code >= 0x61 && code <= 0x7a) ||        // a-z
      c === '_' || c === '-' || c === '~' || c === '.';
    if (isUnreserved) { out += c; continue; }
    if (c === '/' && !encodeSlash) { out += c; continue; }
    // UTF-8 encode
    out += encodeURIComponent(c).replace(/[!'()*]/g, (ch) =>
      '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  }
  return out;
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return { amzDate: `${y}${m}${d}T${hh}${mm}${ss}Z`, dateStamp: `${y}${m}${d}` };
}

function deriveSigningKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

/** Resolve { host, endpointBase, canonicalUri, publicBase } for a given key. */
function resolveEndpoint(cfg: S3Config, key: string): { host: string; endpointBase: string; canonicalUri: string; publicBase: string } {
  const usingCustom = !!cfg.endpoint;
  const forcePath = !!cfg.forcePathStyle;

  const rawBase = usingCustom
    ? cfg.endpoint!.replace(/\/+$/, '')
    : `https://s3.${cfg.region}.amazonaws.com`;

  const url = new URL(rawBase);
  const scheme = url.protocol; // e.g. 'https:'
  const rawHost = url.host;    // e.g. 's3.<region>.amazonaws.com' or 'account.r2.cloudflarestorage.com'
  const port = url.port ? `:${url.port}` : '';

  let host: string;
  let endpointBase: string;
  let canonicalUri: string;

  if (usingCustom || forcePath) {
    // Path-style: /<bucket>/<key>
    host = rawHost + port;
    endpointBase = `${scheme}//${host}`;
    canonicalUri = `/${cfg.bucket}/${uriEncode(key, false)}`;
  } else {
    // Virtual-hosted-style: <bucket>.s3.<region>.amazonaws.com/<key>
    host = `${cfg.bucket}.${rawHost}${port}`;
    endpointBase = `${scheme}//${host}`;
    canonicalUri = `/${uriEncode(key, false)}`;
  }

  const publicBase = cfg.publicBaseUrl ? cfg.publicBaseUrl.replace(/\/+$/, '') : endpointBase;
  return { host, endpointBase, canonicalUri, publicBase };
}

/**
 * Build a SigV4-presigned URL. The signed headers are just `host`, so
 * the browser is free to set its own Content-Type. Payload is
 * UNSIGNED-PAYLOAD which is the standard choice for browser uploads.
 */
export function presign(
  cfg: S3Config,
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
  key: string,
  expiresInSeconds: number,
  now: Date = new Date(),
  extraQuery: Record<string, string> = {},
  /** Additional headers that MUST be included in the SigV4 signature.
   *  AWS requires every `x-amz-*` header sent with the request to appear
   *  in `SignedHeaders` + `canonicalHeaders`. Callers pass the header
   *  values verbatim (trimmed of surrounding whitespace); the presign
   *  function lowercases the names and sorts them for the canonical
   *  request. Ref:
   *  https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html */
  extraSignedHeaders: Record<string, string> = {},
): string {
  const { host, endpointBase, canonicalUri, publicBase } = resolveEndpoint(cfg, key);
  const { amzDate, dateStamp } = amzDates(now);
  const credentialScope = `${dateStamp}/${cfg.region}/${SERVICE}/aws4_request`;

  // Merge host + caller-supplied signed headers. Lowercase keys, sort.
  const allHeaders: Record<string, string> = { host };
  for (const [k, v] of Object.entries(extraSignedHeaders)) {
    allHeaders[k.toLowerCase()] = String(v).trim();
  }
  const sortedNames = Object.keys(allHeaders).sort();
  const signedHeaders = sortedNames.join(';');
  const canonicalHeaders = sortedNames.map((k) => `${k}:${allHeaders[k]}\n`).join('');

  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${cfg.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
    ...extraQuery,
  };
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(queryParams[k]!, true)}`)
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(cfg.secretAccessKey, dateStamp, cfg.region);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  // GET may go through a CDN public base — the signature is bound to the
  // canonical (bucket / key) URI, not the hostname; CDNs that forward
  // query params intact will happily proxy the signed request.
  const base = method === 'GET' ? publicBase : endpointBase;
  return `${base}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly cfg: S3Config;

  constructor(cfg: S3Config) {
    if (!cfg.bucket || !cfg.region || !cfg.accessKeyId || !cfg.secretAccessKey) {
      throw new Error('S3StorageProvider: bucket / region / accessKeyId / secretAccessKey are all required');
    }
    this.cfg = cfg;
  }

  async signUpload(input: SignedUploadRequest): Promise<SignedUploadResult> {
    assertUploadShape(input);
    // Server-generated key — clients never pick the filename.
    const assetId = crypto.randomBytes(12).toString('hex');
    const scope = input.visibility ?? 'private';
    // Layout: <visibility>/<owner>/<property?>/<assetId>
    const propSeg = input.propertyId ? `${input.propertyId}/` : '';
    const providerKey = `${scope}/${input.ownerUserId}/${propSeg}${assetId}`;
    const uploadUrl = presign(this.cfg, 'PUT', providerKey, UPLOAD_TTL_SECONDS);
    return {
      assetId,
      provider: this.name,
      providerKey,
      uploadUrl,
      method: 'PUT',
      // Do NOT force the browser to send extra signed headers — the URL
      // is bound to `host` only, so any content-type the browser picks
      // is accepted by S3. The client will still send its detected MIME.
      headers: {},
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
    };
  }

  async signDownload(providerKey: string, ttlSeconds = DEFAULT_DOWNLOAD_TTL_SECONDS): Promise<SignedDownloadResult> {
    if (!providerKey) throw new Error('providerKey is required');
    const ttl = Math.max(30, Math.min(60 * 60, ttlSeconds));
    const url = presign(this.cfg, 'GET', providerKey, ttl);
    return {
      assetId: providerKey.split('/').pop() ?? '',
      url,
      expiresAt: new Date(Date.now() + ttl * 1000),
    };
  }

  /** HEAD the object over HTTP using a HEAD-signed presigned URL, then a
   *  Range-0-63 GET for magic-byte detection, then a full streaming GET to
   *  compute SHA-256. Yes, this doubles outbound bandwidth for the finalize
   *  window — that's the price of not trusting the client's declared hash.
   *  If throughput becomes a problem, wire a real ClamAV/scanner that
   *  reads the bytes once and returns hash + verdict.
   *
   *  SigV4 note: the HTTP method IS part of the canonical request. Presign
   *  each request with its own method — sending HEAD against a GET-signed
   *  URL is a signature mismatch on any correctly-verifying store. */
  async head(providerKey: string): Promise<StoredObjectStat> {
    if (!providerKey) throw new Error('providerKey is required');
    // 1. HEAD — presigned for HEAD specifically.
    const headUrl = presign(this.cfg, 'HEAD', providerKey, 60);
    const headRes = await fetch(headUrl, { method: 'HEAD' });
    if (headRes.status === 404) throw new Error('NOT_FOUND');
    if (!headRes.ok) throw new Error(`HEAD failed: ${headRes.status}`);
    const cl = headRes.headers.get('content-length');
    if (!cl) throw new Error('HEAD missing content-length');
    const sizeBytes = Number(cl);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new Error('HEAD returned invalid content-length');
    }
    // 2. First 64 bytes for magic-byte detection — presigned as GET+Range.
    const rangeUrl = presign(this.cfg, 'GET', providerKey, 60);
    const rangeRes = await fetch(rangeUrl, { method: 'GET', headers: { range: 'bytes=0-63' } });
    let detected: string | null = null;
    if (rangeRes.ok || rangeRes.status === 206) {
      const buf = Buffer.from(await rangeRes.arrayBuffer());
      const { detectContentType } = await import('./detect.js');
      detected = detectContentType(buf);
    }
    // 3. Full-body streaming SHA-256 — authoritative hash. The finalize
    //    route requires a non-null sha256, so this MUST succeed for the
    //    upload to be accepted.
    const bodyUrl = presign(this.cfg, 'GET', providerKey, 300);
    const bodyRes = await fetch(bodyUrl, { method: 'GET' });
    if (!bodyRes.ok || !bodyRes.body) throw new Error(`GET failed: ${bodyRes.status}`);
    const hash = crypto.createHash('sha256');
    let bytesRead = 0;
    const reader = bodyRes.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) { hash.update(value); bytesRead += value.byteLength; }
    }
    if (bytesRead !== sizeBytes) {
      throw new Error(`GET body length ${bytesRead} != HEAD content-length ${sizeBytes}`);
    }
    return { sizeBytes, detectedContentType: detected, sha256: hash.digest('hex') };
  }

  /** Internal helper: run a signed CopyObject and enforce that the
   *  response is a real success. AWS documents that CopyObject can return
   *  HTTP 200 with an XML `<Error>` body when the copy actually failed
   *  mid-flight — a naive `response.ok` check treats those as success.
   *  We only accept 2xx AND `<CopyObjectResult>` in the body.
   *
   *  Ref: https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
   *
   *  Optionally passes `x-amz-copy-source-if-match: <etag>` so the copy
   *  fails when the source has changed since the caller verified it —
   *  belt-and-braces on top of the verifying-tier quarantine. */
  private async copyObject(
    fromKey: string, toKey: string, ifMatchEtag?: string,
  ): Promise<void> {
    const source = `/${this.cfg.bucket}/${fromKey}`;
    const headers: Record<string, string> = { 'x-amz-copy-source': source };
    if (ifMatchEtag) headers['x-amz-copy-source-if-match'] = ifMatchEtag;
    const copyUrl = presign(this.cfg, 'PUT', toKey, 60, new Date(), {}, headers);
    const copyRes = await fetch(copyUrl, { method: 'PUT', headers });
    if (copyRes.status >= 400) throw new Error(`COPY http ${copyRes.status}`);
    // 200-with-Error XML: parse body and refuse.
    const bodyText = await copyRes.text();
    if (bodyText.includes('<Error>') || bodyText.includes('<Error ')) {
      // Extract <Code>…</Code> for the error message; guard against
      // pathological input.
      const codeMatch = bodyText.match(/<Code>([^<]{1,80})<\/Code>/);
      const code = codeMatch ? codeMatch[1] : 'UnknownCopyError';
      throw new Error(`COPY body error: ${code}`);
    }
    if (!bodyText.includes('<CopyObjectResult')) {
      throw new Error('COPY body missing CopyObjectResult');
    }
  }

  /** Internal helper: signed DELETE (via the DELETE HTTP method, properly
   *  signed) so we do not leak staging or verifying objects. */
  private async deleteObject(key: string): Promise<void> {
    const delUrl = presign(this.cfg, 'DELETE', key, 60);
    const res = await fetch(delUrl, { method: 'DELETE' });
    if (res.status >= 400 && res.status !== 404) {
      throw new Error(`DELETE http ${res.status}`);
    }
  }

  /** Atomically move `uploads/…` into an attempt-scoped quarantine key so
   *  no live signed PUT URL can affect the file we are about to verify.
   *  On S3 this is a CopyObject + Delete; the source (uploads/…) is only
   *  reachable through the client's signed URL which no longer resolves
   *  to bytes after the delete. Uses if-match on the copy to ensure the
   *  bytes we quarantined are exactly what was there. */
  async stage(stagingKey: string, verifyingKey: string): Promise<void> {
    if (!stagingKey || !verifyingKey) throw new Error('stage requires both keys');
    // HEAD source to grab its ETag.
    let etag: string | undefined;
    try {
      const headUrl = presign(this.cfg, 'HEAD', stagingKey, 60);
      const headRes = await fetch(headUrl, { method: 'HEAD' });
      if (headRes.status === 404) throw new Error('NOT_FOUND');
      if (!headRes.ok) throw new Error(`HEAD ${headRes.status}`);
      etag = headRes.headers.get('etag') ?? undefined;
    } catch (e) {
      if ((e as Error).message === 'NOT_FOUND') throw e;
      throw e;
    }
    try {
      await this.copyObject(stagingKey, verifyingKey, etag);
    } catch (e) {
      const msg = (e as Error).message;
      // AWS returns 412 Precondition Failed when if-match does not hold —
      // that means the source changed between our HEAD and copy. Treat as
      // "not found" so finalize retries or gives up cleanly.
      if (msg.includes('412') || msg.includes('PreconditionFailed')) {
        throw new Error('NOT_FOUND');
      }
      throw e;
    }
    // Delete the staging object so a still-valid signed PUT URL cannot
    // affect our quarantine copy.
    try { await this.deleteObject(stagingKey); } catch { /* orphan is harmless */ }
  }

  /** Idempotent delete of a `verifying/…` object. */
  async unstage(verifyingKey: string): Promise<void> {
    try { await this.deleteObject(verifyingKey); } catch { /* best-effort */ }
  }

  /** Atomically promote `verifying/…` bytes to `finalized/…`. Uses the
   *  same CopyObject-with-signed-copy-source machinery as `stage()`, then
   *  deletes the verifying source. Because the verifying key is unreachable
   *  by any signed URL we ever emitted, no external write can affect the
   *  bytes between here and the final copy. */
  async publish(verifyingKey: string, finalKey: string): Promise<void> {
    if (verifyingKey === finalKey) return;
    // ETag of verifying → if-match on the copy.
    let etag: string | undefined;
    try {
      const headUrl = presign(this.cfg, 'HEAD', verifyingKey, 60);
      const headRes = await fetch(headUrl, { method: 'HEAD' });
      if (headRes.status === 404) throw new Error('NOT_FOUND');
      if (!headRes.ok) throw new Error(`HEAD ${headRes.status}`);
      etag = headRes.headers.get('etag') ?? undefined;
    } catch (e) {
      if ((e as Error).message === 'NOT_FOUND') throw e;
      throw e;
    }
    try {
      await this.copyObject(verifyingKey, finalKey, etag);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('412') || msg.includes('PreconditionFailed')) {
        throw new Error('NOT_FOUND');
      }
      // Distinguish idempotent races when the destination already exists.
      if (msg.includes('PreconditionFailed') || msg.includes('BucketAlreadyExists')) {
        throw new Error('ALREADY_PUBLISHED');
      }
      throw e;
    }
    try { await this.deleteObject(verifyingKey); } catch { /* best-effort */ }
  }

  /** Reverse the last publish so finalize can retry after a DB failure. */
  async rollbackPublish(finalKey: string, verifyingKey: string): Promise<void> {
    try {
      const headUrl = presign(this.cfg, 'HEAD', finalKey, 60);
      const headRes = await fetch(headUrl, { method: 'HEAD' });
      if (headRes.status === 404) return;
      const etag = headRes.headers.get('etag') ?? undefined;
      await this.copyObject(finalKey, verifyingKey, etag);
      await this.deleteObject(finalKey);
    } catch { /* best-effort */ }
  }
}
