/**
 * Content-type detection from magic bytes.
 *
 * The client-supplied `Content-Type` header cannot be trusted for security
 * decisions — a malicious client can label a PHP file `image/jpeg`. This
 * module reads the actual first bytes of an uploaded object and returns
 * the base MIME the byte signature identifies, or `null` if unknown.
 *
 * We only recognise MIMEs that our media pipeline accepts (see
 * `ALLOWED_CONTENT_TYPES` in storage-provider.ts). Anything else returns
 * `null` and the finalize route rejects the upload.
 *
 * Signature sources:
 *  - JPEG: FF D8 FF                                (ISO/IEC 10918-1)
 *  - PNG:  89 50 4E 47 0D 0A 1A 0A                 (RFC 2083)
 *  - WEBP: 'RIFF' … 'WEBP' at offsets 0 and 8      (Google WEBP spec)
 *  - HEIC / HEIF: ftyp box at offset 4, brand 'heic'|'heix'|'heif'|'mif1'
 *  - MP4:  ftyp box at offset 4, brand 'mp4' / 'iso' / 'M4V ' / 'avc1'
 *  - MOV (QuickTime): ftyp brand 'qt  '
 *  - WEBM/Matroska: EBML header 1A 45 DF A3
 *  - PDF:  '%PDF-'                                 (ISO 32000-1)
 */

export type DetectableMime =
  | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/heif'
  | 'video/mp4' | 'video/quicktime' | 'video/webm'
  | 'application/pdf';

const jpeg = [0xFF, 0xD8, 0xFF];
const png  = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const pdf  = [0x25, 0x50, 0x44, 0x46, 0x2D]; // "%PDF-"
const webm = [0x1A, 0x45, 0xDF, 0xA3];

function startsWith(buf: Buffer, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
  return true;
}

function isWebp(buf: Buffer): boolean {
  // RIFF....WEBP
  return buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP';
}

/** Read the 4-char ftyp brand at offset 8 when the object starts with `xxxxftyp`.
 *  Returns the lowercased brand or null. Common values:
 *    - image: 'heic' 'heix' 'heif' 'mif1' 'msf1'
 *    - video: 'isom' 'mp41' 'mp42' 'avc1' 'M4V ' 'qt  ' */
function ftypBrand(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return null;
  return buf.toString('ascii', 8, 12).toLowerCase().trim();
}

export function detectContentType(buf: Buffer): DetectableMime | null {
  if (!buf || buf.length === 0) return null;
  if (startsWith(buf, jpeg)) return 'image/jpeg';
  if (startsWith(buf, png))  return 'image/png';
  if (startsWith(buf, pdf))  return 'application/pdf';
  if (startsWith(buf, webm)) return 'video/webm';
  if (isWebp(buf))           return 'image/webp';
  const brand = ftypBrand(buf);
  if (brand) {
    if (brand === 'heic' || brand === 'heix') return 'image/heic';
    if (brand === 'heif' || brand === 'mif1' || brand === 'msf1') return 'image/heif';
    if (brand === 'qt') return 'video/quicktime';
    // treat every other MP4 brand family as MP4 — 'isom' / 'mp41' / 'mp42' /
    // 'avc1' / 'iso2' / 'M4V' / 'M4A' / 'dash' all live in the ISO BMFF family.
    return 'video/mp4';
  }
  return null;
}

/** True when the declared MIME is compatible with the detected MIME.
 *  We treat the image/heic ↔ image/heif pair as interchangeable because
 *  cameras label them inconsistently. Same for video/mp4 subtype brands. */
export function contentTypeCompatible(declared: string, detected: DetectableMime): boolean {
  if (declared === detected) return true;
  if ((declared === 'image/heic' && detected === 'image/heif') ||
      (declared === 'image/heif' && detected === 'image/heic')) return true;
  return false;
}
