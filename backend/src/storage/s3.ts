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
  method: 'GET' | 'PUT',
  key: string,
  expiresInSeconds: number,
  now: Date = new Date(),
  extraQuery: Record<string, string> = {},
): string {
  const { host, endpointBase, canonicalUri, publicBase } = resolveEndpoint(cfg, key);
  const { amzDate, dateStamp } = amzDates(now);
  const credentialScope = `${dateStamp}/${cfg.region}/${SERVICE}/aws4_request`;

  const signedHeaders = 'host';
  const canonicalHeaders = `host:${host}\n`;

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
}
