/**
 * Browser E2E — guest-capture consent flow against the REAL backend.
 *
 * We can't literally sign a visitor in from inside headless Playwright
 * without their consent, so this spec simulates the exact state the
 * SPA ends up in post-login:
 *
 *   1. Visitor is on /ar unauthenticated → they tap "التقاط" and
 *      "نشر"; publishShots() stashes the capture under
 *      `guest::<pid|unbound>` in IndexedDB and bounces to login. We
 *      simulate that stash directly through `page.evaluate` because
 *      MediaRecorder isn't available in headless Chromium.
 *   2. The owner finishes login — we set the owner JWT in
 *      sessionStorage and open /ar/owner/properties.
 *   3. The PropertyMediaGallery picks the guest bucket up through
 *      peekGuestCapture() and renders the consent banner.
 *   4. Two assertions:
 *      (a) "اربطه بحسابي" promotes the capture under the authenticated
 *          `user:<uid>::<pid>` key. The guest bucket is cleared.
 *      (b) In a second fresh visit, "تجاهل الملف" clears the guest
 *          bucket without touching anything else.
 *
 * Nothing is uploaded in this spec — we only assert the consent
 * ceremony itself. The upload round trip is already covered by
 * `journey.spec.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

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

/**
 * Write a fake capture to the shared IndexedDB store under the guest
 * key. Matches `pending-capture.ts`'s keyFor(''=guest, propertyId).
 * Running inside the page so the write targets the SAME origin DB the
 * owner panel will later read.
 */
async function stashGuestCapture(page: Page, propertyId: string, payload: { bytes: number; recordedAt: number }) {
  await page.evaluate(async (args) => {
    const { propertyId, bytes, recordedAt } = args;
    const key = `guest::${propertyId}`;
    const blob = new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('sakanhub-pending-capture', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('captures');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('captures', 'readwrite');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        const store = tx.objectStore('captures');
        store.put(blob, key);
        store.put({
          mimeType: 'video/mp4', userId: '', propertyId,
          recordedAt, fileName: 'guest-capture.mp4',
        }, key + ':meta');
      };
      req.onerror = () => reject(req.error);
    });
  }, { propertyId, ...payload });
}

async function peekKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve) => {
    const req = indexedDB.open('sakanhub-pending-capture', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('captures', 'readonly');
      const keys: string[] = [];
      const cursor = tx.objectStore('captures').openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) { keys.push(String(c.key)); c.continue(); }
        else { db.close(); resolve(keys); }
      };
      cursor.onerror = () => { db.close(); resolve(keys); };
    };
    req.onerror = () => resolve([]);
  }));
}

test.describe('/ar/owner/properties — guest-capture consent', () => {
  test('owner sees consent banner → "اربطه بحسابي" promotes guest to user bucket', async ({ page }) => {
    const state = loadState();
    const WEB_BASE = process.env.SAKAN_WEB_BASE || 'http://127.0.0.1:3101';

    // Prime owner session + stash a guest capture BEFORE navigation.
    await page.addInitScript((token: string) => {
      try { window.sessionStorage.setItem('sh_owner_token', token); } catch {}
    }, state.owner.token);
    // Visit the origin once so IndexedDB is on the right origin.
    await page.goto(`${WEB_BASE}/ar`);
    await stashGuestCapture(page, state.property.id, { bytes: 128, recordedAt: Date.now() - 60_000 });
    expect(await peekKeys(page)).toContain('guest::' + state.property.id);

    // Open the owner panel + the editor for our property.
    await page.goto(`${WEB_BASE}/ar/owner/properties`);
    await page.locator('li', { hasText: state.property.listingNumber }).getByRole('button', { name: 'تعديل' }).click();
    await page.getByRole('button', { name: /الوسائط$/ }).click();

    // Consent banner (role="dialog") appears with the exact copy.
    const banner = page.getByRole('dialog', { name: 'موافقة ربط التصوير بالحساب' });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('تصوير محفوظ قبل تسجيل الدخول');
    await expect(banner).toContainText('هل تربطه بحسابك الحالي');

    // Click "اربطه بحسابي" — promoteGuestCapture must swap keys.
    await banner.getByRole('button', { name: 'اربطه بحسابي' }).click();

    // Give IDB a tick to flush, then verify the key swap.
    await page.waitForTimeout(400);
    const after = await peekKeys(page);
    const userKey = `user:${state.owner.id}::${state.property.id}`;
    expect(after, 'guest bucket must be cleared after consent').not.toContain('guest::' + state.property.id);
    expect(after, 'promoted capture must live under the user+property key').toContain(userKey);
    // The consent banner disappears after the click.
    await expect(banner).not.toBeVisible();
  });

  test('promoteGuestCapture REFUSES to overwrite an existing user bucket — guest capture stays intact for retry', async ({ page }) => {
    const state = loadState();
    const WEB_BASE = process.env.SAKAN_WEB_BASE || 'http://127.0.0.1:3101';
    await page.addInitScript((token: string) => {
      try { window.sessionStorage.setItem('sh_owner_token', token); } catch {}
    }, state.owner.token);
    await page.goto(`${WEB_BASE}/ar`);

    // Seed BOTH a guest bucket AND a pre-existing user bucket for the
    // same (owner, property) pair. The user bucket must NOT be
    // silently clobbered; the guest bucket must survive the refused
    // promotion so the owner can retry after resolving the conflict.
    const uid = state.owner.id;
    const pid = state.property.id;
    await page.evaluate(async ({ uid, pid }) => {
      const open = () => new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('sakanhub-pending-capture', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('captures');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const put = (store: IDBObjectStore, k: string, v: unknown) => new Promise<void>((res, rej) => {
        const r = store.put(v, k); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      });
      const db = await open();
      const tx = db.transaction('captures', 'readwrite');
      const store = tx.objectStore('captures');
      // Guest capture (fresh).
      const guestBlob = new Blob([new Uint8Array(400)], { type: 'video/mp4' });
      await put(store, `guest::${pid}`, guestBlob);
      await put(store, `guest::${pid}:meta`, {
        mimeType: 'video/mp4', userId: '', propertyId: pid,
        recordedAt: Date.now() - 60_000, fileName: 'guest.mp4',
      });
      // Pre-existing user capture (what the owner was working on).
      const userBlob = new Blob([new Uint8Array(800)], { type: 'video/mp4' });
      await put(store, `user:${uid}::${pid}`, userBlob);
      await put(store, `user:${uid}::${pid}:meta`, {
        mimeType: 'video/mp4', userId: uid, propertyId: pid,
        recordedAt: Date.now() - 10_000, fileName: 'owner.mp4',
      });
      await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
      db.close();
    }, { uid, pid });

    // Capture window.alert so the test can observe the UX message
    // without a human to click OK.
    const alerts: string[] = [];
    page.on('dialog', (d) => { alerts.push(d.message()); void d.dismiss(); });

    await page.goto(`${WEB_BASE}/ar/owner/properties`);
    await page.locator('li', { hasText: state.property.listingNumber }).getByRole('button', { name: 'تعديل' }).click();
    await page.getByRole('button', { name: /الوسائط$/ }).click();

    const banner = page.getByRole('dialog', { name: 'موافقة ربط التصوير بالحساب' });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await banner.getByRole('button', { name: 'اربطه بحسابي' }).click();
    await page.waitForTimeout(400);

    // The alert tells the owner about the conflict (user-visible).
    expect(alerts.some((m) => m.includes('يوجد لديك بالفعل مقطع'))).toBe(true);

    // IDB state proof: BOTH buckets still exist, nothing clobbered.
    const after = await peekKeys(page);
    expect(after, 'guest bucket preserved for retry').toContain('guest::' + pid);
    expect(after, 'existing user bucket preserved').toContain(`user:${uid}::${pid}`);

    // Both blobs are their original sizes (owner's 800B stayed 800B,
    // guest's 400B stayed 400B). This proves there was no partial
    // overwrite inside the aborted transaction.
    const sizes = await page.evaluate(async ({ uid, pid }) => {
      const open = () => new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open('sakanhub-pending-capture', 1);
        req.onsuccess = () => resolve(req.result);
      });
      const get = (store: IDBObjectStore, k: string) => new Promise<Blob | undefined>((r) => {
        const req = store.get(k); req.onsuccess = () => r(req.result as Blob | undefined);
      });
      const db = await open();
      const tx = db.transaction('captures', 'readonly');
      const store = tx.objectStore('captures');
      const g = await get(store, `guest::${pid}`);
      const u = await get(store, `user:${uid}::${pid}`);
      db.close();
      return { guest: g?.size ?? 0, user: u?.size ?? 0 };
    }, { uid, pid });
    expect(sizes.guest).toBe(400);
    expect(sizes.user).toBe(800);
  });

  test('UI click on "اربطه بحسابي" with injected mid-write failure: source preserved, destination empty, retry succeeds after clearing hook', async ({ page }) => {
    // Scope: the destination-conflict path aborts BEFORE any put, so
    // it does not exercise IDB rollback. Here we drive the REAL
    // production `promoteGuestCapture` through the owner's banner
    // click, injecting the failure via the test-only hook. This
    // proves THREE things in one run:
    //   (a) the real function catches the mid-flight failure and
    //       returns reason:'io' (surfaced as an alert to the owner),
    //   (b) IDB rolls back the puts — destination bucket stays empty,
    //       source bucket stays at its exact original size,
    //   (c) after clearing the hook, a second UI click succeeds —
    //       the owner can retry without having lost their recording.
    const state = loadState();
    const WEB_BASE = process.env.SAKAN_WEB_BASE || 'http://127.0.0.1:3101';
    const uid = state.owner.id;
    const pid = state.property.id;
    const GUEST_SIZE = 777;

    await page.addInitScript((token: string) => {
      try { window.sessionStorage.setItem('sh_owner_token', token); } catch {}
    }, state.owner.token);
    await page.goto(`${WEB_BASE}/ar`);
    await stashGuestCapture(page, pid, { bytes: GUEST_SIZE, recordedAt: Date.now() - 90_000 });

    // Capture alert() so the test can confirm the UX message is
    // triggered by the real promoteGuestCapture failure path.
    const alerts: string[] = [];
    page.on('dialog', (d) => { alerts.push(d.message()); void d.dismiss(); });

    await page.goto(`${WEB_BASE}/ar/owner/properties`);
    await page.locator('li', { hasText: state.property.listingNumber }).getByRole('button', { name: 'تعديل' }).click();
    await page.getByRole('button', { name: /الوسائط$/ }).click();

    // Arm the test-only hook via the e2e-gated window bridge. The
    // bridge is only exposed when NEXT_PUBLIC_SAKAN_E2E=true at
    // build time; the production build has no such symbol.
    const bridgePresent = await page.evaluate(() => !!(window as unknown as { __sakanPendingCaptureTestBridge?: unknown }).__sakanPendingCaptureTestBridge);
    expect(bridgePresent, 'e2e build must expose the test bridge').toBe(true);
    await page.evaluate(() => {
      const bridge = (window as unknown as { __sakanPendingCaptureTestBridge: { setPromoteTestHook: (h: unknown) => void } }).__sakanPendingCaptureTestBridge;
      bridge.setPromoteTestHook((phase: string) => {
        if (phase === 'after-user-put') throw new Error('simulated-mid-flight-crash');
      });
    });

    // Real UI click: owner taps «اربطه بحسابي» on the consent banner.
    const banner = page.getByRole('dialog', { name: 'موافقة ربط التصوير بالحساب' });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await banner.getByRole('button', { name: 'اربطه بحسابي' }).click();
    await page.waitForTimeout(400);

    // (a) The real function surfaced the io failure to the owner.
    expect(alerts.some((m) => m.includes('تعذّر الوصول للتخزين المحلي'))).toBe(true);

    // (b) IDB state: source preserved AT ITS ORIGINAL SIZE, no partial
    //     destination write landed.
    const afterFail = await page.evaluate(async ({ uid, pid }) => {
      const open = () => new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open('sakanhub-pending-capture', 1);
        r.onsuccess = () => resolve(r.result);
      });
      const get = (store: IDBObjectStore, k: string) => new Promise<unknown>((r) => {
        const req = store.get(k); req.onsuccess = () => r(req.result);
      });
      const db = await open();
      const tx = db.transaction('captures', 'readonly');
      const store = tx.objectStore('captures');
      const g = (await get(store, `guest::${pid}`)) as Blob | undefined;
      const gm = (await get(store, `guest::${pid}:meta`)) as unknown;
      const u = (await get(store, `user:${uid}::${pid}`)) as Blob | undefined;
      const um = (await get(store, `user:${uid}::${pid}:meta`)) as unknown;
      db.close();
      return { guestBlob: g?.size ?? 0, guestMeta: !!gm, userBlob: u?.size ?? 0, userMeta: !!um };
    }, { uid, pid });
    expect(afterFail.guestBlob, 'guest blob preserved at original size').toBe(GUEST_SIZE);
    expect(afterFail.guestMeta).toBe(true);
    expect(afterFail.userBlob, 'user bucket rolled back — no partial write landed').toBe(0);
    expect(afterFail.userMeta, 'user meta rolled back too').toBe(false);

    // (c) Clear the hook and click again. The real function must now
    //     complete the promotion, draining the source and writing the
    //     destination. The alert buffer gains no new error.
    const alertCountBefore = alerts.length;
    await page.evaluate(() => {
      const bridge = (window as unknown as { __sakanPendingCaptureTestBridge: { clearPromoteTestHook: () => void } }).__sakanPendingCaptureTestBridge;
      bridge.clearPromoteTestHook();
    });
    // Re-open the editor so the banner picks up the still-present
    // guest capture (the component only reads IDB on mount).
    await page.goto(`${WEB_BASE}/ar/owner/properties`);
    await page.locator('li', { hasText: state.property.listingNumber }).getByRole('button', { name: 'تعديل' }).click();
    await page.getByRole('button', { name: /الوسائط$/ }).click();
    const banner2 = page.getByRole('dialog', { name: 'موافقة ربط التصوير بالحساب' });
    await expect(banner2).toBeVisible({ timeout: 10_000 });
    await banner2.getByRole('button', { name: 'اربطه بحسابي' }).click();
    await page.waitForTimeout(400);
    expect(alerts.length, 'retry must not raise another alert').toBe(alertCountBefore);
    // IDB state after successful retry: source drained, destination
    // populated with the ORIGINAL blob size (not corrupted).
    const afterRetry = await page.evaluate(async ({ uid, pid }) => {
      const open = () => new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open('sakanhub-pending-capture', 1);
        r.onsuccess = () => resolve(r.result);
      });
      const get = (store: IDBObjectStore, k: string) => new Promise<unknown>((r) => {
        const req = store.get(k); req.onsuccess = () => r(req.result);
      });
      const db = await open();
      const tx = db.transaction('captures', 'readonly');
      const store = tx.objectStore('captures');
      const g = (await get(store, `guest::${pid}`)) as Blob | undefined;
      const u = (await get(store, `user:${uid}::${pid}`)) as Blob | undefined;
      db.close();
      return { guestBlob: g?.size ?? 0, userBlob: u?.size ?? 0 };
    }, { uid, pid });
    expect(afterRetry.guestBlob, 'guest bucket drained on successful retry').toBe(0);
    expect(afterRetry.userBlob, 'destination now holds the original blob size').toBe(GUEST_SIZE);
  });

  test('"تجاهل الملف" clears the guest bucket without creating a user bucket', async ({ page }) => {
    const state = loadState();
    const WEB_BASE = process.env.SAKAN_WEB_BASE || 'http://127.0.0.1:3101';
    await page.addInitScript((token: string) => {
      try { window.sessionStorage.setItem('sh_owner_token', token); } catch {}
    }, state.owner.token);
    await page.goto(`${WEB_BASE}/ar`);
    await stashGuestCapture(page, state.property.id, { bytes: 64, recordedAt: Date.now() - 30_000 });
    expect(await peekKeys(page)).toContain('guest::' + state.property.id);

    await page.goto(`${WEB_BASE}/ar/owner/properties`);
    await page.locator('li', { hasText: state.property.listingNumber }).getByRole('button', { name: 'تعديل' }).click();
    await page.getByRole('button', { name: /الوسائط$/ }).click();
    const banner = page.getByRole('dialog', { name: 'موافقة ربط التصوير بالحساب' });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await banner.getByRole('button', { name: 'تجاهل الملف' }).click();
    await page.waitForTimeout(400);
    const after = await peekKeys(page);
    expect(after, 'guest bucket cleared').not.toContain('guest::' + state.property.id);
    const userKey = `user:${state.owner.id}::${state.property.id}`;
    expect(after, 'no promotion happened — user bucket must not exist').not.toContain(userKey);
  });
});
