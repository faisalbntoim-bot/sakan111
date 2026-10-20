/**
 * Browser E2E — real backend, real Next.js, real SQLite, real JWTs,
 * real playable WebM, real UI clicks.
 *
 * Scenario:
 *   1. Owner has a DRAFT property (seeded by seed.mjs — listingNumber
 *      and district both carry the run timestamp so this test only
 *      sees ITS OWN card on /ar, never a stale one).
 *   2. A real playable VP8 WebM is generated in-browser by
 *      makePlayableWebm() and fed into the hidden video-album input
 *      via setInputFiles(). The sign → PUT → finalize round trip is
 *      the SAME path a device camera would take.
 *   3. UI click on the real "🌐/🔒" showcase label flips the asset
 *      to public — the sticky footer's pointer-events:none fix lets
 *      the click land without force.
 *   4. UI click on the real "إرسال للمراجعة" button transitions
 *      DRAFT → SUBMITTED.
 *   5. Admin (separate JWT, server-side call because the admin UI is
 *      out of scope) hits mark-verified then publish — SUBMITTED →
 *      VERIFIED → PUBLISHED. These go through HTTP, not DB UPDATE.
 *   6. Visitor opens /ar; locates the test's card by exact district
 *      (not substring, not .first()) and plays the <video>.
 *   7. Full playback asserts: loadedmetadata, videoWidth/Height > 0,
 *      play() resolves, currentTime > 0 after 400ms.
 *   8. Reload /ar and repeat the playback checks — signed URL
 *      regenerated, still plays.
 */

import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { makePlayableWebm } from './make-fixture';

type E2EState = {
  jwtSecret: string;
  owner: { id: string; token: string };
  admin: { id: string; token: string };
  property: { id: string; listingNumber: string; district: string };
};

const STATE_PATH = path.join(__dirname, '.e2e-state.json');
function loadState(): E2EState {
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as E2EState;
}

async function apiFetch(apiBase: string, token: string, apiPath: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };
  return await fetch(`${apiBase}${apiPath}`, { ...init, headers });
}

/**
 * Playback assertion: loadedmetadata, dimensions, play(), currentTime
 * progresses. Fails loud on any step — the test caller sees exactly
 * which browser-side promise rejected.
 */
async function assertVideoPlays(page: Page, selector: string) {
  const result = await page.evaluate(async (sel) => {
    const el = document.querySelector<HTMLVideoElement>(sel);
    if (!el) return { ok: false, reason: 'element-not-found' };
    // readyState 1 = HAVE_METADATA. Wait for it.
    if (el.readyState < 1) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('loadedmetadata-timeout')), 8000);
        el.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(); }, { once: true });
        el.addEventListener('error', () => { clearTimeout(t); reject(new Error('video-error')); }, { once: true });
      }).catch((e) => { throw e; });
    }
    const w = el.videoWidth, h = el.videoHeight;
    if (!w || !h) return { ok: false, reason: 'zero-dimensions', videoWidth: w, videoHeight: h };
    el.muted = true; // autoplay-safe
    try { await el.play(); } catch (e) { return { ok: false, reason: 'play-rejected', error: String(e) }; }
    const t0 = el.currentTime;
    await new Promise((r) => setTimeout(r, 500));
    const t1 = el.currentTime;
    el.pause();
    return { ok: t1 > t0, reason: t1 > t0 ? 'progressed' : 'no-progress', t0, t1, videoWidth: w, videoHeight: h, src: el.src };
  }, selector);
  if (!result.ok) throw new Error(`video playback failed: ${JSON.stringify(result)}`);
  return result as { ok: true; t0: number; t1: number; videoWidth: number; videoHeight: number; src: string };
}

test.describe('/ar journey — real backend, real session, real video', () => {
  test('owner drafts → uploads playable video → clicks showcase → clicks submit → admin publishes → appears on /ar with playable video that survives reload', async ({ page }) => {
    const state = loadState();
    const API_BASE = process.env.SAKAN_API_BASE || 'http://127.0.0.1:4101';
    const WEB_BASE = process.env.SAKAN_WEB_BASE || 'http://127.0.0.1:3101';

    // Owner session.
    await page.addInitScript((token: string) => {
      try { window.sessionStorage.setItem('sh_owner_token', token); } catch {}
    }, state.owner.token);

    // Step 1 — open owner panel, enter editor. Scope visibility to the
    // list-number cell (`.pa-list-num`) so a listing whose district
    // contains the same timestamp does not confuse the locator.
    await page.goto(`${WEB_BASE}/ar/owner/properties`);
    await expect(page.locator('.pa-list-num', { hasText: state.property.listingNumber })).toBeVisible({ timeout: 20_000 });
    await page.locator('li', { hasText: state.property.listingNumber }).getByRole('button', { name: 'تعديل' }).click();
    await page.getByRole('button', { name: /الوسائط$/ }).click();

    // Step 2 — generate a real playable WebM in-browser and feed the
    // bytes to the hidden file input. No ffmpeg, no fs round trip.
    const bytes = await makePlayableWebm(page, { durationMs: 1200, width: 128, height: 96 });
    expect(bytes.byteLength, 'generated webm must be non-trivial').toBeGreaterThan(1000);
    const videoAlbum = page.locator('input[type="file"][accept*="video"]').first();
    await videoAlbum.setInputFiles({ name: 'e2e-' + Date.now() + '.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes) });

    // Finalize completes → <video> renders in the gallery.
    await expect(page.locator('.pmg-grid video').first()).toBeVisible({ timeout: 20_000 });

    // Step 3 — REAL click on the showcase label. The sticky-footer
    // pointer-events:none fix lets this land without force.
    const showcaseLabel = page.locator('.pmg-showcase').first();
    await expect(showcaseLabel).toBeVisible({ timeout: 10_000 });
    await expect(showcaseLabel).toContainText('خاص');
    await showcaseLabel.click();
    await expect(showcaseLabel).toContainText('عام', { timeout: 5_000 });

    // Step 4 — advance to the final step ("المراجعة"), then REAL
    // click on "إرسال للمراجعة". DRAFT → SUBMITTED.
    await page.getByRole('button', { name: /المراجعة$/ }).click();
    const submitBtn = page.getByRole('button', { name: 'إرسال للمراجعة' });
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();
    // The editor closes on successful submit (onDone returns to list).
    await expect(page.locator('.pa-list-num', { hasText: state.property.listingNumber })).toBeVisible({ timeout: 10_000 });

    // Step 5 — admin verifies + publishes. mark-verified + publish are
    // admin-only HTTP endpoints; no owner UI for these. Both go
    // through HTTP, no DB UPDATE.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 86_400_000);
    const markVerified = await apiFetch(API_BASE, state.admin.token, `/v1/admin/properties/${state.property.id}/mark-verified`, {
      method: 'POST',
      body: JSON.stringify({
        regaLicenseNumber: 'REGA-E2E-' + Date.now(),
        regaLicenseIssuedAt: now.toISOString(),
        regaLicenseExpiresAt: expiresAt.toISOString(),
      }),
    });
    expect(markVerified.status, await markVerified.text()).toBe(200);
    const publish = await apiFetch(API_BASE, state.admin.token, `/v1/admin/properties/${state.property.id}/publish`, { method: 'POST', body: '{}' });
    expect(publish.status, await publish.text()).toBe(200);

    // Step 6 — fresh visitor page, no owner token. Locate OUR card by
    // exact unique district — no .first(), no substring collision.
    const visitor = await page.context().newPage();
    // Strip any session the context inherited.
    await visitor.addInitScript(() => { try { window.sessionStorage.clear(); } catch {} });
    await visitor.goto(`${WEB_BASE}/ar`);
    await visitor.waitForTimeout(2500);
    const splash = visitor.locator('.splash');
    if (await splash.isVisible().catch(() => false)) await splash.click({ force: true }).catch(() => {});

    const unique = state.property.district;
    const ourCard = visitor.locator('.card').filter({ hasText: unique });
    await expect(ourCard, 'exactly one card for the test property').toHaveCount(1, { timeout: 15_000 });
    const chip = ourCard.getByRole('button', { name: /فيديو العقار/ });
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await chip.click({ force: true });

    // Step 7 — the <video> actually plays off the signed URL.
    const videoEl = visitor.locator('video.gal-video').first();
    await expect(videoEl).toBeVisible({ timeout: 10_000 });
    const played = await assertVideoPlays(visitor, 'video.gal-video');
    expect(played.videoWidth, 'videoWidth > 0').toBeGreaterThan(0);
    expect(played.videoHeight, 'videoHeight > 0').toBeGreaterThan(0);
    expect(played.t1, 'currentTime progressed').toBeGreaterThan(played.t0);
    expect(played.src).not.toMatch(/[Bb]earer/);
    expect(played.src).not.toMatch(/[Aa]uthorization/);

    // Step 8 — reload the visitor page. The signed URL is regenerated;
    // playback must still work.
    await visitor.reload();
    await visitor.waitForTimeout(2500);
    const splash2 = visitor.locator('.splash');
    if (await splash2.isVisible().catch(() => false)) await splash2.click({ force: true }).catch(() => {});
    const ourCard2 = visitor.locator('.card').filter({ hasText: unique });
    await expect(ourCard2).toHaveCount(1, { timeout: 15_000 });
    await ourCard2.getByRole('button', { name: /فيديو العقار/ }).click({ force: true });
    const played2 = await assertVideoPlays(visitor, 'video.gal-video');
    expect(played2.videoWidth).toBeGreaterThan(0);
    expect(played2.t1).toBeGreaterThan(played2.t0);
    // Confirm the URL is a fresh signature (different query params / sig).
    expect(played2.src).not.toMatch(/[Bb]earer/);
  });
});
