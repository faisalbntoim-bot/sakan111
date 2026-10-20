/**
 * Browser-side fixture generator — produces a REAL playable WebM
 * video by driving an off-screen canvas through MediaRecorder, same
 * code path a device camera would use. The resulting bytes are a
 * fully decodable video, so <video>.loadedmetadata and .play() work
 * in the e2e assertions.
 *
 * We generate it inside the test's own Chromium process (NOT at
 * build time) because:
 *   - no system ffmpeg is available in this sandbox,
 *   - Playwright's bundled ffmpeg is `--disable-everything` and
 *     cannot encode VP8 from an image,
 *   - Chromium always has MediaRecorder + canvas.captureStream.
 *
 * Returns the file as a Uint8Array so the caller can pass it to
 * `setInputFiles({ name, mimeType, buffer })`.
 */
import type { Page } from '@playwright/test';

export async function makePlayableWebm(page: Page, opts: { durationMs?: number; width?: number; height?: number } = {}): Promise<Uint8Array> {
  const durationMs = opts.durationMs ?? 1200;
  const width = opts.width ?? 128;
  const height = opts.height ?? 96;
  const arrayB64 = await page.evaluate(async ({ durationMs, width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d ctx');
    // Pick the first MediaRecorder MIME the browser actually supports.
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = candidates.find((m) => (window as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('no supported MediaRecorder mime');
    const stream = (canvas as unknown as { captureStream: (fps: number) => MediaStream }).captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 200_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(100);
    const startedAt = performance.now();
    // Draw moving frames so VP8 actually has content to encode.
    await new Promise<void>((resolve) => {
      function tick() {
        const t = performance.now() - startedAt;
        const g = Math.round(32 + 128 * Math.abs(Math.sin(t / 150)));
        ctx!.fillStyle = `rgb(${g},${g},${g})`;
        ctx!.fillRect(0, 0, width, height);
        ctx!.fillStyle = '#fff';
        ctx!.font = '16px sans-serif';
        ctx!.fillText('e2e ' + Math.round(t), 8, 24);
        if (t >= durationMs) resolve(); else requestAnimationFrame(tick);
      }
      tick();
    });
    rec.stop();
    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: mime }));
    });
    const ab = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    // Base64-encode so we can return it through evaluate (which can't ship binary).
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
  }, { durationMs, width, height });
  const binStr = Buffer.from(arrayB64, 'base64');
  return new Uint8Array(binStr);
}
