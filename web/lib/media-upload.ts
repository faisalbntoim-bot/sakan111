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

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — matches backend MAX_UPLOAD_BYTES

export class MediaUploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function ownerToken(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
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

/** Reject files client-side before we spend bandwidth on them. */
export function validateFile(file: File): void {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new MediaUploadError('BAD_MIME', 'صيغة الصورة غير مدعومة. المسموح: JPEG / PNG / WebP / HEIC.');
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    throw new MediaUploadError('BAD_SIZE', 'حجم الصورة يجب أن يكون أقل من 25 ميجابايت.');
  }
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

async function requestUploadUrl(input: {
  file: File; propertyId?: string; sha256: string;
}): Promise<SignedUpload> {
  assertApi();
  // Backend allowlist covers image/heic; frontend sends whatever the OS
  // reported. If a Safari device reports image/heif we downgrade to heic
  // on the wire so the backend accepts it — the bytes are identical.
  const contentType = input.file.type === 'image/heif' ? 'image/heic' : input.file.type;
  const res = await fetch(`${API_BASE}/v1/media/upload-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer() },
    body: JSON.stringify({
      kind: 'image',
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

/** Rewrite the sandbox URL so it points at a real HTTP endpoint the browser can PUT to. */
function normaliseUploadUrl(url: string): string {
  if (url.startsWith('sandbox://upload/')) {
    // sandbox://upload/<providerKey>?ct=<mime>  →  ${API_BASE}/v1/media/sandbox-upload/<providerKey>
    const rest = url.slice('sandbox://upload/'.length);
    const q = rest.indexOf('?');
    const key = q === -1 ? rest : rest.slice(0, q);
    return `${API_BASE}/v1/media/sandbox-upload/${key}`;
  }
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
  signed: SignedUpload; file: File; sha256: string; propertyId?: string;
}): Promise<MediaAssetRow> {
  assertApi();
  const contentType = input.file.type === 'image/heif' ? 'image/heic' : input.file.type;
  const res = await fetch(`${API_BASE}/v1/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer() },
    body: JSON.stringify({
      assetId: input.signed.assetId,
      providerKey: input.signed.providerKey,
      kind: 'image',
      contentType,
      sizeBytes: input.file.size,
      sha256: input.sha256,
      propertyId: input.propertyId,
      visibility: 'private',
    }),
  });
  if (!res.ok) throw new MediaUploadError('FINALIZE_FAILED', 'تعذّر تسجيل الصورة، حاول مجددًا.');
  const raw = await res.json() as { id: string; propertyId: string | null; kind: string; mimeType: string; sizeBytes: number; visibility: 'public' | 'private'; createdAt: string };
  return { ...raw, url: null };
}

/** Full pipeline for one file — retriable at the call site. */
export async function uploadOne(input: {
  file: File; propertyId?: string; onProgress?: UploadProgress;
}): Promise<MediaAssetRow> {
  validateFile(input.file);
  const digest = await sha256Hex(input.file);
  const signed = await requestUploadUrl({ file: input.file, propertyId: input.propertyId, sha256: digest });
  const target = normaliseUploadUrl(signed.uploadUrl);
  const contentType = input.file.type === 'image/heif' ? 'image/heic' : input.file.type;
  await putFileWithProgress(target, input.file, contentType, signed.headers ?? {}, input.onProgress);
  return await finalizeAsset({ signed, file: input.file, sha256: digest, propertyId: input.propertyId });
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

export async function deleteMedia(id: string): Promise<void> {
  assertApi();
  const res = await fetch(`${API_BASE}/v1/media/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { ...bearer() },
  });
  if (res.status === 404) throw new MediaUploadError('NOT_FOUND', 'الصورة غير موجودة.');
  if (!res.ok) throw new MediaUploadError('DELETE_FAILED', 'تعذّر حذف الصورة.');
}

export const MEDIA_LIMITS = {
  maxBytes: MAX_BYTES,
  allowedMime: Array.from(ALLOWED_MIME),
};
