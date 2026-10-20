/**
 * Media upload helper — real end-to-end flow for property images.
 *
 * Steps (matches backend media.ts):
 *   1. Compute SHA-256 of the file in the browser (WebCrypto).
 *   2. POST /v1/media/upload-url → { uploadUrl, assetId, providerKey, headers }.
 *   3. PUT the file bytes directly to `uploadUrl` (with per-file progress).
 *      When the backend hands back a `sandbox://` URL (dev only) we
 *      transparently rewrite it to `${API_BASE}/v1/media/sandbox-upload/<key>`
 *      so browsers can actually PUT.
 *   4. POST /v1/media to register the MediaAsset row.
 *
 * All calls use the caller's owner session token (sh_owner_token from
 * property-authoring lib). No secret, no upload URL, and no upstream
 * token is ever put in the DOM by this helper.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '';
const TOKEN_KEY = 'sh_owner_token';

const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ALLOWED_VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;  // 15 MB — matches backend MEDIA_IMAGE_MAX_BYTES default
const VIDEO_MAX_BYTES = 300 * 1024 * 1024; // 300 MB — matches backend MEDIA_VIDEO_MAX_BYTES default

export class MediaUploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function ownerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

/**
 * Decode the `sub` claim out of the owner JWT without verifying its
 * signature — the server-side guard is where trust lives. We use this
 * only to NAMESPACE browser-local artifacts (an IndexedDB key, a
 * pending-capture bucket) so a prior account's cached work never
 * surfaces under a new account on the same device.
 */
export function ownerUserId(): string | null {
  const tok = ownerToken();
  if (!tok) return null;
  try {
    const seg = tok.split('.')[1];
    if (!seg) return null;
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice(0, (4 - (b64.length % 4)) % 4);
    const json = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json) as { sub?: string };
    return payload.sub ?? null;
  } catch { return null; }
}

function bearer(): Record<string, string> {
  const t = ownerToken();
  if (!t) throw new MediaUploadError('NO_AUTH', 'الرجاء تسجيل الدخول أولاً.');
  return { 'authorization': `Bearer ${t}` };
}

function assertApi(): void {
  if (!API_BASE) throw new MediaUploadError('NO_API_BASE', 'API غير مُهيَّأ (NEXT_PUBLIC_API_BASE_URL مفقود).');
}

/** SHA-256 → lowercase hex. Uses SubtleCrypto — available in every modern browser. */
export async function sha256Hex(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await window.crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/** Strip `;codecs=…` etc. so the backend allowlist matches the base MIME. */
function baseMime(t: string): string {
  const i = t.indexOf(';');
  return i === -1 ? t : t.slice(0, i).trim();
}

/** Classify a browser File as image / video. Returns null for unsupported. */
export function classifyFile(file: File): 'image' | 'video' | null {
  const t = baseMime(file.type);
  if (ALLOWED_IMAGE_MIME.has(t)) return 'image';
  if (ALLOWED_VIDEO_MIME.has(t)) return 'video';
  return null;
}

/** Reject files client-side before we spend bandwidth on them. */
export function validateFile(file: File): 'image' | 'video' {
  const kind = classifyFile(file);
  if (!kind) {
    throw new MediaUploadError('BAD_MIME', 'صيغة الملف غير مدعومة.');
  }
  const max = kind === 'image' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (file.size <= 0 || file.size > max) {
    const mb = Math.round(max / (1024 * 1024));
    throw new MediaUploadError('BAD_SIZE', `الحد الأقصى ${mb} ميجابايت.`);
  }
  return kind;
}

export type SignedUpload = {
  assetId: string;
  provider: string;
  providerKey: string;
  uploadUrl: string;
  method: 'PUT' | 'POST';
  headers?: Record<string, string>;
  expiresAt: string;
};

function normaliseContentType(raw: string, kind: 'image' | 'video'): string {
  const base = baseMime(raw);
  // iOS sometimes reports image/heif; backend allowlist entries include
  // both, but we normalise here anyway to be defensive against browser
  // variants that add codec suffixes.
  return base || (kind === 'image' ? 'image/jpeg' : 'video/webm');
}

async function requestUploadUrl(input: {
  file: File; kind: 'image' | 'video'; propertyId?: string; sha256: string;
}): Promise<SignedUpload> {
  assertApi();
  const contentType = normaliseContentType(input.file.type, input.kind);
  const res = await fetch(`${API_BASE}/v1/media/upload-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer() },
    body: JSON.stringify({
      kind: input.kind,
      contentType,
      sizeBytes: input.file.size,
      sha256: input.sha256,
      propertyId: input.propertyId,
      visibility: 'private',
    }),
  });
  if (res.status === 401 || res.status === 403) throw new MediaUploadError('AUTH_EXPIRED', 'انتهت الجلسة.');
  if (!res.ok) throw new MediaUploadError('SIGN_FAILED', 'تعذّر تحضير الرفع، حاول مجددًا.');
  return await res.json() as SignedUpload;
}

/** Turn provider-scheme URLs into a real HTTP endpoint the browser can PUT to.
 *
 *  - sandbox:// (dev)   → same-origin /v1/media/sandbox-upload/<key>
 *  - /v1/media/local-upload/…  (local, production; already relative) → prefixed with API_BASE
 *  - https:// (s3 / cloud) → passed through
 */
function normaliseUploadUrl(url: string): string {
  if (url.startsWith('sandbox://upload/')) {
    const rest = url.slice('sandbox://upload/'.length);
    const q = rest.indexOf('?');
    const key = q === -1 ? rest : rest.slice(0, q);
    return `${API_BASE}/v1/media/sandbox-upload/${key}`;
  }
  if (url.startsWith('/')) return `${API_BASE}${url}`; // local provider returns relative paths
  return url;
}

type UploadProgress = (loaded: number, total: number) => void;

/** PUT the raw file bytes. Uses XHR so we can report per-file progress. */
function putFileWithProgress(
  targetUrl: string, file: File, contentType: string, headers: Record<string, string> = {}, onProgress?: UploadProgress,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', targetUrl, true);
    xhr.setRequestHeader('content-type', contentType);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new MediaUploadError('PUT_FAILED', `فشل رفع الصورة (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new MediaUploadError('NETWORK', 'انقطع الاتصال أثناء الرفع.'));
    xhr.ontimeout = () => reject(new MediaUploadError('TIMEOUT', 'انتهى وقت الرفع.'));
    xhr.timeout = 120 * 1000; // 2 minutes per file
    xhr.send(file);
  });
}

export type MediaAssetRow = {
  id: string;
  propertyId: string | null;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  visibility: 'public' | 'private';
  createdAt: string;
  url: string | null;
};

async function finalizeAsset(input: {
  signed: SignedUpload; file: File; kind: 'image' | 'video'; sha256: string; propertyId?: string;
}): Promise<MediaAssetRow> {
  assertApi();
  const contentType = normaliseContentType(input.file.type, input.kind);
  const res = await fetch(`${API_BASE}/v1/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer() },
    body: JSON.stringify({
      assetId: input.signed.assetId,
      providerKey: input.signed.providerKey,
      kind: input.kind,
      contentType,
      sizeBytes: input.file.size,
      sha256: input.sha256,
      propertyId: input.propertyId,
      visibility: 'private',
    }),
  });
  if (!res.ok) throw new MediaUploadError('FINALIZE_FAILED', 'تعذّر تسجيل الملف، حاول مجددًا.');
  const raw = await res.json() as { id: string; propertyId: string | null; kind: string; mimeType: string; sizeBytes: number; visibility: 'public' | 'private'; createdAt: string };
  return { ...raw, url: null };
}

/** Full pipeline for one file — retriable at the call site. */
export async function uploadOne(input: {
  file: File; propertyId?: string; onProgress?: UploadProgress;
}): Promise<MediaAssetRow> {
  const kind = validateFile(input.file);
  const digest = await sha256Hex(input.file);
  const signed = await requestUploadUrl({ file: input.file, kind, propertyId: input.propertyId, sha256: digest });
  const target = normaliseUploadUrl(signed.uploadUrl);
  const contentType = normaliseContentType(input.file.type, kind);
  await putFileWithProgress(target, input.file, contentType, signed.headers ?? {}, input.onProgress);
  return await finalizeAsset({ signed, file: input.file, kind, sha256: digest, propertyId: input.propertyId });
}

/** List the caller's media, optionally scoped to one property. */
export async function listMedia(propertyId?: string): Promise<MediaAssetRow[]> {
  assertApi();
  const url = propertyId
    ? `${API_BASE}/v1/media?propertyId=${encodeURIComponent(propertyId)}`
    : `${API_BASE}/v1/media`;
  const res = await fetch(url, { method: 'GET', headers: { ...bearer() } });
  if (res.status === 401 || res.status === 403) throw new MediaUploadError('AUTH_EXPIRED', 'انتهت الجلسة.');
  if (!res.ok) throw new MediaUploadError('LIST_FAILED', 'تعذّر جلب الصور.');
  const body = await res.json() as { items: MediaAssetRow[] };
  return body.items;
}

/**
 * Flip a MediaAsset's showcase visibility. `isPublic:true` makes it
 * eligible for public surfacing on the homepage feed (once the parent
 * property is PUBLISHED); `isPublic:false` returns it to private.
 *
 * The server rejects a non-owner with 404 — this helper does not
 * silently cover that up; the caller receives a MediaUploadError.
 */
export async function setMediaShowcase(id: string, isPublic: boolean): Promise<{ id: string; visibility: 'public' | 'private' }> {
  assertApi();
  const res = await fetch(`${API_BASE}/v1/media/${encodeURIComponent(id)}/showcase`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...bearer() },
    body: JSON.stringify({ public: isPublic }),
  });
  if (res.status === 401 || res.status === 403) throw new MediaUploadError('AUTH_EXPIRED', 'انتهت الجلسة.');
  if (res.status === 404) throw new MediaUploadError('NOT_FOUND', 'الوسيط غير موجود.');
  if (!res.ok) throw new MediaUploadError('SHOWCASE_FAILED', 'تعذّر تعديل العرض العام للملف.');
  return await res.json() as { id: string; visibility: 'public' | 'private' };
}

export async function deleteMedia(id: string): Promise<void> {
  assertApi();
  const res = await fetch(`${API_BASE}/v1/media/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { ...bearer() },
  });
  if (res.status === 404) throw new MediaUploadError('NOT_FOUND', 'الصورة غير موجودة.');
  if (!res.ok) throw new MediaUploadError('DELETE_FAILED', 'تعذّر حذف الصورة.');
}

/** Absolute URL to a local-provider stream endpoint, wrapped with the API base. */
export function resolveMediaUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  if (u.startsWith('/')) return `${API_BASE}${u}`;
  return u;
}

export const MEDIA_LIMITS = {
  imageMaxBytes: IMAGE_MAX_BYTES,
  videoMaxBytes: VIDEO_MAX_BYTES,
  allowedImageMime: Array.from(ALLOWED_IMAGE_MIME),
  allowedVideoMime: Array.from(ALLOWED_VIDEO_MIME),
};
