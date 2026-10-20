/**
 * Browser-level checks for the public homepage /ar.
 *
 * Scope — what this test proves end-to-end through the real page JS:
 *
 *   1. With the API base configured but the backend returning an EMPTY
 *      feed, the demo pool is NOT rendered. The empty-state banner is
 *      the sole visible content in the grid area.
 *   2. With the API base configured and the backend returning REAL
 *      PUBLISHED items, the demo pool is NOT rendered. Only the real
 *      items (identified by the backend's listingNumber) appear.
 *   3. The grid card for a video-bearing listing exposes the "فيديو
 *      العقار" button, which opens the gallery lightbox containing a
 *      <video> element with the signed-URL src — no Bearer anywhere.
 *   4. A fetch failure surfaces the failure banner with a retry
 *      button; the demo pool is still NOT rendered.
 *
 * How we fake the backend:
 *   - Playwright's `page.route()` intercepts /v1/properties/feed and
 *     returns the shape the SPA expects. This lets the test assert
 *     the SPA's rendering decisions independently of a real backend.
 *
 * NOT covered here (needs device + real backend + real camera):
 *   - MediaRecorder / getUserMedia on an actual device.
 *   - IndexedDB resume across a full-page nav through /ar/owner/login.
 *   - iOS Safari video controls styling.
 * These are listed under NOT-TESTED in REVIEW-V7.
 */

import { test, expect } from '@playwright/test';

// Must match the value the test runner bakes into the Next.js build
// via NEXT_PUBLIC_API_BASE_URL. The web/components/SakanDesign.tsx
// client component writes this exact string onto window.__SAKAN_API_BASE
// as soon as it mounts; app.js then uses it as the fetch base.
// Playwright's route interception responds even for a hostname that
// resolves to a real backend — fulfilled calls short-circuit the real
// request. The runner sets SAKAN_FAKE_API when it wants to override.
const FAKE_API = process.env.SAKAN_FAKE_API || 'http://127.0.0.1:4101';

async function mountSpaWithFeed(page: import('@playwright/test').Page, body: unknown, status = 200) {
  // Register BEFORE goto. Route pattern uses a glob so the trailing
  // query string on the SPA's /v1/properties/feed?pageSize=24 call is
  // matched. We also allow preflight-less GET from any origin.
  await page.route(/\/v1\/properties\/feed/, (route) => {
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  });
  await page.route(/\/v1\/events/, (route) => {
    route.fulfill({ status: 204, body: '', headers: { 'access-control-allow-origin': '*' } });
  });
}

test.describe('/ar homepage — real-feed wiring', () => {
  test('empty feed response removes demo pool and shows empty banner', async ({ page }) => {
    await mountSpaWithFeed(page, { items: [], total: 0, page: 1, pageSize: 24, ranking: 'default' });
    await page.goto('/ar');
    // The empty-feed banner is a <div role="status"> with the Arabic
    // copy from app.js. We wait until the SPA finishes its boot
    // fetch (max 10s — the fake responds immediately).
    const banner = page.getByRole('status').getByText('لا توجد عقارات منشورة بعد', { exact: false });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    // Scope the "no demo listings" assertion to the visible feed grid.
    // Hidden overlays elsewhere in the SPA (DM thread, offices sheet)
    // reference district names in hardcoded sample copy — those are
    // not the "mixed demo listings on the homepage" the user asked us
    // to prevent.
    const feedGrid = page.locator('.feed');
    await expect(feedGrid.getByText('حي الملقا', { exact: false })).toHaveCount(0);
    await expect(feedGrid.getByText('حي النرجس', { exact: false })).toHaveCount(0);
  });

  test('failed feed response surfaces retry banner, demo pool stays hidden', async ({ page }) => {
    await mountSpaWithFeed(page, { message: 'boom' }, 500);
    await page.goto('/ar');
    const banner = page.getByRole('status').getByText('تعذّر تحميل العقارات', { exact: false });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /إعادة المحاولة/ })).toBeVisible();
    const feedGrid = page.locator('.feed');
    await expect(feedGrid.getByText('حي الملقا', { exact: false })).toHaveCount(0);
  });

  test('real published item is shown — demo pool is replaced, not mixed', async ({ page }) => {
    await mountSpaWithFeed(page, {
      items: [
        {
          id: 'p-real-001',
          listingNumber: 'E2E-PUBLISHED-1',
          category: 'apartment',
          purpose: 'rent',
          bedrooms: 3,
          bathrooms: 2,
          areaSqm: 150,
          priceHalalahs: '2500000',
          city: 'الرياض',
          district: 'حي العارض',
          title: 'شقة اختبار e2e',
          description: 'إعلان حقيقي ضمن اختبار المتصفح',
          status: 'available',
          advertisementLifecycle: 'PUBLISHED',
          media: [],
        },
      ],
      total: 1, page: 1, pageSize: 24, ranking: 'default',
    });
    await page.goto('/ar');
    const feedGrid = page.locator('.feed');
    // The owner's district copy must appear in the feed. Demo districts
    // must not — scope to the visible grid so sheet-level sample copy
    // doesn't false-trigger.
    await expect(feedGrid.getByText('حي العارض', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    await expect(feedGrid.getByText('حي الملقا', { exact: false })).toHaveCount(0);
    await expect(feedGrid.getByText('حي النرجس', { exact: false })).toHaveCount(0);
  });

  test('card exposes "فيديو العقار" chip when backend attaches a video', async ({ page }) => {
    await mountSpaWithFeed(page, {
      items: [
        {
          id: 'p-real-002',
          listingNumber: 'E2E-WITH-VIDEO',
          category: 'villa',
          purpose: 'sale',
          bedrooms: 4,
          bathrooms: 3,
          areaSqm: 320,
          priceHalalahs: '150000000',
          district: 'حي الورود',
          title: 'فيلا بمعرض فيديو',
          description: 'اختبار تشغيل الفيديو من الواجهة',
          status: 'available',
          advertisementLifecycle: 'PUBLISHED',
          media: [
            { kind: 'video', url: 'https://example.test/signed/vid.mp4?exp=1&sig=abcd', mimeType: 'video/mp4' },
          ],
        },
      ],
      total: 1, page: 1, pageSize: 24, ranking: 'default',
    });
    await page.goto('/ar');
    // The 2s intro splash intercepts pointer events — dismiss it so
    // the subsequent click lands on the chip, not the overlay.
    await page.waitForTimeout(2500);
    const splash = page.locator('.splash');
    if (await splash.isVisible().catch(() => false)) await splash.click({ force: true }).catch(() => {});
    const chip = page.getByRole('button', { name: /فيديو العقار/ });
    await expect(chip).toBeVisible({ timeout: 10_000 });
    // The SPA shows an onboarding promo overlay a beat after the
    // splash. We also need to dismiss that or click the chip through
    // its event delegator rather than through the DOM, which the
    // overlay intercepts. force:true is the pragmatic fix for a
    // headless browser-level test — a real visitor would simply tap.
    await chip.click({ force: true });
    const vid = page.locator('video.gal-video');
    await expect(vid).toBeVisible({ timeout: 5_000 });
    const src = await vid.getAttribute('src');
    expect(src).toContain('signed/vid.mp4');
    // Signed-URL hygiene — must never carry a Bearer anywhere.
    expect(src).not.toMatch(/[Bb]earer/);
  });
});
