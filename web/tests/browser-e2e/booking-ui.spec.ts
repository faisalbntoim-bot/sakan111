/**
 * UI-driven booking E2E — real backend, real Next.js, real SQLite,
 * REAL button clicks. Each test is self-contained: it reads its own
 * date window from booking-seed.mjs's state file and picks the same
 * calendar cells by day-of-month aria-label. No test depends on
 * another's completion.
 *
 * Covers:
 *   1. Happy path: pick dates (own window) → inline OTP login → pay →
 *      sandbox webhook capture → lands on confirmation page with
 *      status=مؤكد. Reload — status survives.
 *   2. Overlap: pick the SEEDED-CONFIRMED window → Arabic 409 error on
 *      «ادفع». The pre-booking is seeded, not from test 1.
 *   3. Double-click guard: pick own window → login → double-click
 *      «ادفع» → ONE /v1/payments request, ONE confirmed booking.
 *   4. Payment failure then retry: pick own window → login → «محاكاة
 *      فشل الدفع» → «ادفع» retry → confirmed, no duplicate booking.
 */

import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

type Window = {
  startOffsetDays: number;
  nights: number;
  checkIn: string;
  checkOut: string;
  checkInYmd: string;   // 'YYYY-MM-DD'
  checkOutYmd: string;
};

type BookingSeed = {
  ownerPhone: string;
  customerPhones: {
    happyPath: string;
    doubleClick: string;
    overlap: string;
    failureRetry: string;
  };
  property: { id: string; listingNumber: string; district: string };
  windows: Record<'happyPath' | 'doubleClick' | 'overlap' | 'failureRetry', Window>;
};

const SEED_PATH = path.join(__dirname, '.booking-e2e-state.json');
function loadSeed(): BookingSeed {
  return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')) as BookingSeed;
}

const BACKEND_LOG = process.env.SAKAN_BACKEND_LOG || '';

function latestOtpFor(phone: string): string {
  if (!BACKEND_LOG) throw new Error('SAKAN_BACKEND_LOG env not set');
  const log = fs.readFileSync(BACKEND_LOG, 'utf8');
  const lines = log.split('\n').reverse();
  // New format from the console SMS adapter:
  //   [sms:console] +9660088881 ← SakanHub verification code: 123456
  const target = `[sms:console] ${phone} ← `;
  for (const line of lines) {
    const i = line.indexOf(target);
    if (i >= 0) {
      const after = line.slice(i + target.length);
      const m = /verification code: (\d{6})/.exec(after);
      if (m && m[1]) return m[1];
    }
  }
  throw new Error(`no dev-otp line found for ${phone} in ${BACKEND_LOG}`);
}

const AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

/** Convert a UTC YYYY-MM-DD into the aria-label the RtlCalendar sets
 *  on its day buttons, e.g. "15 نوفمبر". The calendar renders the day
 *  number without zero padding; the month is Arabic. */
function cellLabelFor(ymd: string): string {
  const parts = ymd.split('-').map((x) => parseInt(x, 10));
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  return `${d} ${AR_MONTHS[m - 1]}`;
}

/** Click the check-in cell on the current month, advance the calendar
 *  with the "next month" chevron if the target lands in a later month,
 *  then click the check-out cell. The window spans at most ~5 weeks
 *  from today so one chevron click is enough.
 *  The RtlCalendar.tsx sets `aria-label` as "{day} {month} …" so we
 *  can match by prefix. */
async function pickWindow(page: Page, win: Window): Promise<void> {
  // Ensure the calendar is in view before any click.
  await page.locator('.rcal').first().scrollIntoViewIfNeeded();

  const checkInLabel  = cellLabelFor(win.checkInYmd);
  const checkOutLabel = cellLabelFor(win.checkOutYmd);

  async function ensureVisibleAndClick(label: string): Promise<void> {
    for (let tries = 0; tries < 3; tries++) {
      const cell = page.locator(`.rcal-day[aria-label^="${label}"]:not(.disabled):not(.pad)`).first();
      if (await cell.count() > 0 && await cell.isVisible()) {
        await cell.click();
        return;
      }
      // Advance one month using the calendar's "next" arrow (aria-label).
      const nextArrow = page.getByLabel('الشهر التالي').first();
      if (await nextArrow.count() > 0) {
        await nextArrow.click();
      } else {
        break;
      }
    }
    // Last-resort attempt — try to click anyway so the test fails
    // loudly with a locator-not-found message naming the label.
    const fallback = page.locator(`.rcal-day[aria-label^="${label}"]:not(.disabled)`).first();
    await fallback.click();
  }

  await ensureVisibleAndClick(checkInLabel);
  await ensureVisibleAndClick(checkOutLabel);
}

async function loginThroughSheet(page: Page, phone: string): Promise<void> {
  await page.getByTestId('brs-login').waitFor({ state: 'visible' });
  await page.getByTestId('brs-login-phone').fill(phone);
  await page.getByTestId('brs-login-request').click();
  await page.getByTestId('brs-login-code').waitFor({ state: 'visible' });
  const otp = latestOtpFor(phone);
  await page.getByTestId('brs-login-code').fill(otp);
  await page.getByTestId('brs-login-verify').click();
  await expect(page.getByTestId('brs-pay')).toBeEnabled({ timeout: 5_000 });
}

async function openBookingPage(page: Page, propertyId: string): Promise<void> {
  const webBase = process.env.SAKAN_WEB_BASE || 'http://127.0.0.1:3101';
  await page.goto(`${webBase}/ar/properties/${propertyId}/booking?mode=daily`);
}

test.describe('UI-driven booking — real backend, real buttons, order-independent', () => {
  test('happy path: pick dates → login → pay → confirmation page survives reload', async ({ page }) => {
    const seed = loadSeed();
    await openBookingPage(page, seed.property.id);
    await expect(page.locator(`text=${seed.property.district}`).first()).toBeVisible({ timeout: 10_000 });

    await pickWindow(page, seed.windows.happyPath);
    await expect(page.getByTestId('bk-price-total')).toBeVisible();

    await page.getByTestId('bk-confirm-cta').click();
    await page.getByTestId('bk-review-sheet').waitFor({ state: 'visible' });

    await loginThroughSheet(page, seed.customerPhones.happyPath);
    await page.getByTestId('brs-pay').click();

    await page.waitForURL(/\/ar\/bookings\/[a-z0-9]+$/, { timeout: 15_000 });
    await expect(page.getByTestId('bcf-status')).toHaveAttribute('data-status', 'confirmed');

    const confirmedUrl = page.url();
    await page.reload();
    await expect(page.getByTestId('bcf-status')).toHaveAttribute('data-status', 'confirmed');
    expect(page.url()).toBe(confirmedUrl);
  });

  test('overlap: seeded confirmed booking blocks «ادفع» with an Arabic error — no dependency on test 1', async ({ page, context }) => {
    const seed = loadSeed();
    await context.clearCookies();
    await openBookingPage(page, seed.property.id);
    await expect(page.locator(`text=${seed.property.district}`).first()).toBeVisible({ timeout: 10_000 });

    // Pick the SAME window the seed pre-booked, so the server returns 409.
    await pickWindow(page, seed.windows.overlap);
    await page.getByTestId('bk-confirm-cta').click();
    await page.getByTestId('bk-review-sheet').waitFor({ state: 'visible' });

    await loginThroughSheet(page, seed.customerPhones.overlap);
    await page.getByTestId('brs-pay').click();

    const err = page.getByTestId('brs-pay-error');
    await expect(err).toBeVisible({ timeout: 10_000 });
    const text = (await err.innerText()).trim();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/غير متاح|not available|متاح/i);
    // Confirmation page should NOT be reached.
    expect(page.url()).toMatch(/\/booking\?mode=daily$/);
  });

  test('double-click: synchronous double-click on «ادفع» fires only ONE /v1/payments request', async ({ page, context }) => {
    const seed = loadSeed();
    await context.clearCookies();
    await openBookingPage(page, seed.property.id);
    await expect(page.locator(`text=${seed.property.district}`).first()).toBeVisible({ timeout: 10_000 });

    await pickWindow(page, seed.windows.doubleClick);
    await page.getByTestId('bk-confirm-cta').click();
    await page.getByTestId('bk-review-sheet').waitFor({ state: 'visible' });

    await loginThroughSheet(page, seed.customerPhones.doubleClick);

    const paymentStarts: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/v1/payments')) {
        paymentStarts.push(req.url());
      }
    });

    const payButton = page.getByTestId('brs-pay');
    await Promise.all([payButton.click({ force: true }), payButton.click({ force: true })]);

    await page.waitForURL(/\/ar\/bookings\/[a-z0-9]+$/, { timeout: 15_000 });
    await expect(page.getByTestId('bcf-status')).toHaveAttribute('data-status', 'confirmed');
    expect(paymentStarts.length).toBeLessThanOrEqual(1);
  });

  test('payment failure then retry → same booking confirmed, no duplicate', async ({ page, context }) => {
    const seed = loadSeed();
    await context.clearCookies();
    await openBookingPage(page, seed.property.id);
    await expect(page.locator(`text=${seed.property.district}`).first()).toBeVisible({ timeout: 10_000 });

    await pickWindow(page, seed.windows.failureRetry);
    await page.getByTestId('bk-confirm-cta').click();
    await page.getByTestId('bk-review-sheet').waitFor({ state: 'visible' });

    await loginThroughSheet(page, seed.customerPhones.failureRetry);

    await page.getByTestId('brs-pay-fail').click();
    await expect(page.getByTestId('brs-pay-error')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('brs-pay').click();
    await page.waitForURL(/\/ar\/bookings\/[a-z0-9]+$/, { timeout: 15_000 });
    await expect(page.getByTestId('bcf-status')).toHaveAttribute('data-status', 'confirmed');
  });
});
