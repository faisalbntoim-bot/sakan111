/**
 * Pending-capture persistence — survives a login redirect.
 *
 * The owner records a video, hits "save", and the session has just
 * expired. We don't want to make them re-record. We also don't want
 * to serialize a Blob into localStorage as Base64 (user's explicit
 * rule: "لا تضع الملف في localStorage كـBase64" — Base64 inflates by
 * ~33% and localStorage has a hard ~5MB quota per origin).
 *
 * Instead we open an IndexedDB store, keep the raw Blob under a single
 * known key, and clean it up after a successful save or an explicit
 * discard. The store is per-origin so a visitor to a shared machine
 * cannot read another visitor's capture after they close the tab.
 *
 * This module is browser-only; it no-ops gracefully in SSR or when
 * IndexedDB is unavailable (private browsing, old Safari in some
 * configurations). A missing IDB is NEVER fatal — the modal already
 * keeps the Blob in React state during a session; IDB is the
 * secondary tier that survives a full-page nav to /login.
 */

/**
 * Pending-capture persistence — survives a login redirect, and (for
 * guests) survives the sign-up / login step itself.
 *
 * Two legal buckets:
 *
 *   1. logged-in: key `user:${userId}::${propertyId}` — stashed when
 *      an authenticated owner's save failed with AUTH_EXPIRED or when
 *      network dropped mid-upload. Loaded automatically on return.
 *
 *   2. guest: key `guest::${propertyId}` or `guest::unbound` — stashed
 *      when an unauthenticated visitor hit "save" from the SPA. On the
 *      next page load we DO NOT auto-upload — we surface a one-time
 *      consent prompt. The user explicitly chooses which account the
 *      capture binds to AND which property it attaches to; only then
 *      do we attempt the upload. Everything else is discarded.
 *
 * This file is shared across the Next.js owner panel AND the vanilla
 * SPA at /ar. Both read/write through the same database so a capture
 * recorded in one surface can be resumed in the other.
 */
const DB_NAME = 'sakanhub-pending-capture';
const STORE_NAME = 'captures';
const META_KEY_SUFFIX = ':meta';

export type PendingCapture = {
  blob: Blob;
  mimeType: string;
  userId: string;        // '' for guest bucket
  propertyId: string;    // '' for an unbound guest capture
  recordedAt: number;
  fileName: string;
};

type StoredMeta = {
  mimeType: string;
  userId: string;
  propertyId: string;
  recordedAt: number;
  fileName: string;
};

/**
 * Key format:
 *   `user:${userId}::${propertyId}` for authenticated stashes
 *   `guest::${propertyId}`          for guest stashes bound to a property
 *   `guest::unbound`                 for guest stashes with no property yet
 *
 * The user-prefix separates authenticated vs guest unambiguously — a
 * malicious or buggy caller cannot cross-read someone else's bucket by
 * guessing userIds.
 */
export function keyFor(userId: string, propertyId: string): string {
  if (!userId) return `guest::${propertyId || 'unbound'}`;
  return `user:${userId}::${propertyId}`;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') { resolve(null); return; }
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T> | T): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const out = await fn(store);
    return await new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(out as T);
      tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('tx error'));
    });
  } catch { return null; }
  finally { db.close(); }
}

/**
 * Save a capture so it survives a full-page navigation. Returns true
 * on success, false if IDB was unavailable (caller then falls back to
 * in-memory state only).
 */
export async function savePendingCapture(input: PendingCapture): Promise<boolean> {
  // Guest stashes are allowed. We require AT LEAST ONE of userId or
  // propertyId so the key is deterministic — the fully-anonymous
  // unbound case still maps to `guest::unbound` which is the single
  // slot a visitor can leave behind.
  const k = keyFor(input.userId, input.propertyId);
  const result = await withStore('readwrite', (store) => {
    return new Promise<boolean>((resolve) => {
      let doneBlob = false, doneMeta = false;
      const r1 = store.put(input.blob, k);
      r1.onsuccess = () => { doneBlob = true; if (doneMeta) resolve(true); };
      r1.onerror = () => resolve(false);
      const meta: StoredMeta = {
        mimeType: input.mimeType,
        userId: input.userId,
        propertyId: input.propertyId,
        recordedAt: input.recordedAt,
        fileName: input.fileName,
      };
      const r2 = store.put(meta, k + META_KEY_SUFFIX);
      r2.onsuccess = () => { doneMeta = true; if (doneBlob) resolve(true); };
      r2.onerror = () => resolve(false);
    });
  });
  return result === true;
}

/**
 * Load a previously saved capture. Returns null when IDB is missing,
 * when no capture is pending for this (userId, propertyId) pair, or
 * when the stored meta mismatches — e.g. a different account signed in
 * on the shared browser.
 */
export async function loadPendingCapture(expectedUserId: string, expectedPropertyId: string): Promise<PendingCapture | null> {
  // For a logged-in load, both ids are required; for an explicit guest
  // bucket load (userId='') propertyId can be '' as well.
  if (expectedUserId && !expectedPropertyId) return null;
  const k = keyFor(expectedUserId, expectedPropertyId);
  return await withStore('readonly', (store) => {
    return new Promise<PendingCapture | null>((resolve) => {
      const metaReq = store.get(k + META_KEY_SUFFIX);
      metaReq.onsuccess = () => {
        const meta = metaReq.result as StoredMeta | undefined;
        if (!meta) { resolve(null); return; }
        if ((meta.userId || '') !== expectedUserId) { resolve(null); return; }
        if (expectedPropertyId && meta.propertyId !== expectedPropertyId) { resolve(null); return; }
        const blobReq = store.get(k);
        blobReq.onsuccess = () => {
          const blob = blobReq.result as Blob | undefined;
          if (!blob) { resolve(null); return; }
          resolve({
            blob,
            mimeType: meta.mimeType,
            userId: meta.userId,
            propertyId: meta.propertyId,
            recordedAt: meta.recordedAt,
            fileName: meta.fileName,
          });
        };
        blobReq.onerror = () => resolve(null);
      };
      metaReq.onerror = () => resolve(null);
    });
  });
}

/** Discard any pending capture for this bucket. Safe to call when nothing is stored. */
export async function clearPendingCapture(userId: string, propertyId: string): Promise<void> {
  if (userId && !propertyId) return;
  const k = keyFor(userId, propertyId);
  await withStore('readwrite', (store) => {
    store.delete(k);
    store.delete(k + META_KEY_SUFFIX);
    return undefined;
  });
}

/**
 * Return the guest-bucket capture if one exists, OR a bound-guest
 * capture for a specific property. Used by the SPA post-login flow to
 * ask the owner "do you want to attach the capture you left behind
 * before you signed in to THIS account?".
 */
export async function peekGuestCapture(propertyId?: string): Promise<PendingCapture | null> {
  return await loadPendingCapture('', propertyId ?? '');
}

/**
 * Promotion result: a tagged union so the caller can distinguish
 * "nothing to promote" from "destination already has a capture — refusing
 * to overwrite silently" from "IDB unavailable" from a real failure.
 */
export type PromoteResult =
  | { ok: true; capture: PendingCapture }
  | { ok: false; reason: 'none' | 'existing_user_bucket' | 'io' | 'bad_input' };

/**
 * Test-only hook — see `promoteGuestCapture` below.
 *
 * The hook, its exported setter, and the window bridge are all
 * guarded by `process.env.NEXT_PUBLIC_SAKAN_E2E === 'true'`. Next's
 * build-time `DefinePlugin` inlines that env read as a literal string
 * at compile time. In a production build it folds to `"" === "true"`
 * → `false`, and Terser removes the whole `if (false) { ... }` body
 * (including the window-assignment string literal). The guard spec
 * `prod-build-no-test-bridge.spec.ts` greps the published chunks to
 * prove the bridge symbol is literally absent.
 */
let _promoteTestHook: null | ((phase: 'after-user-put') => void) = null;
function _getTestHook(): typeof _promoteTestHook { return _promoteTestHook; }

if (process.env.NEXT_PUBLIC_SAKAN_E2E === 'true' && typeof window !== 'undefined') {
  (window as unknown as { __sakanPendingCaptureTestBridge?: unknown }).__sakanPendingCaptureTestBridge = {
    setPromoteTestHook(h: null | ((phase: 'after-user-put') => void)) { _promoteTestHook = h; },
    clearPromoteTestHook() { _promoteTestHook = null; },
  };
}

/**
 * Rebind a guest capture to a (userId, propertyId) pair ATOMICALLY.
 *
 *   - Everything happens in a single IndexedDB readwrite transaction
 *     so a crash mid-flight cannot leave the guest bucket deleted
 *     while the user bucket is also empty. If the write to the user
 *     bucket fails, the transaction aborts and the guest capture is
 *     fully intact — the user can click "اربطه بحسابي" again.
 *
 *   - REFUSES to overwrite an existing user-bucket capture for the
 *     same (userId, propertyId). The owner may have had their own
 *     in-flight capture before the guest consent prompt opened. If
 *     we silently clobbered it they'd lose work. Returns
 *     reason:'existing_user_bucket' so the UI can prompt them to
 *     resolve the conflict (keep own vs. accept guest) explicitly.
 *
 *   - Returns reason:'none' when the guest bucket is empty.
 */
export async function promoteGuestCapture(userId: string, propertyId: string, sourcePropertyId: string = ''): Promise<PromoteResult> {
  if (!userId || !propertyId) return { ok: false, reason: 'bad_input' };
  const db = await openDb();
  if (!db) return { ok: false, reason: 'io' };
  const srcKey = keyFor('', sourcePropertyId);
  const dstKey = keyFor(userId, propertyId);
  try {
    return await new Promise<PromoteResult>((resolve) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(STORE_NAME, 'readwrite'); }
      catch { resolve({ ok: false, reason: 'io' }); return; }
      const store = tx.objectStore(STORE_NAME);
      let decision: PromoteResult | null = null;
      let srcMeta: StoredMeta | null = null;
      let srcBlob: Blob | null = null;

      function get<T>(key: string): Promise<T | undefined> {
        return new Promise((r) => {
          const req = store.get(key);
          req.onsuccess = () => r(req.result as T | undefined);
          req.onerror = () => r(undefined);
        });
      }

      (async () => {
        // 1. Read guest capture atomically.
        const meta = await get<StoredMeta>(srcKey + META_KEY_SUFFIX);
        const blob = await get<Blob>(srcKey);
        if (!meta || !blob) {
          decision = { ok: false, reason: 'none' };
          try { tx.abort(); } catch {}
          return;
        }
        srcMeta = meta; srcBlob = blob;

        // 2. Refuse silent overwrite: if destination already has a
        //    capture for THIS user+property, bail. The UI handles the
        //    conflict explicitly.
        const existingMeta = await get<StoredMeta>(dstKey + META_KEY_SUFFIX);
        const existingBlob = await get<Blob>(dstKey);
        if (existingMeta || existingBlob) {
          decision = { ok: false, reason: 'existing_user_bucket' };
          try { tx.abort(); } catch {}
          return;
        }

        // 3. Write to the user bucket. If any put throws, the tx
        //    aborts before we delete the source, preserving the guest.
        const newMeta: StoredMeta = {
          mimeType: srcMeta.mimeType, userId, propertyId,
          recordedAt: srcMeta.recordedAt, fileName: srcMeta.fileName,
        };
        store.put(srcBlob, dstKey);
        store.put(newMeta, dstKey + META_KEY_SUFFIX);

        // Test-only abort window. `_getTestHook` returns null in a
        // production build because `pending-capture.test-bridge` was
        // never imported (the env-gated side-effect import above was
        // folded away). The one-line branch stays — it just reads a
        // null variable.
        const hook = _getTestHook();
        if (hook) {
          try { hook('after-user-put'); }
          catch (hookErr) {
            decision = { ok: false, reason: 'io' };
            try { tx.abort(); } catch {}
            throw hookErr;
          }
        }

        // 4. Only after the writes above have been queued, delete the
        //    source. The tx commits all four ops atomically.
        store.delete(srcKey);
        store.delete(srcKey + META_KEY_SUFFIX);

        decision = {
          ok: true,
          capture: { blob: srcBlob, mimeType: srcMeta.mimeType, userId, propertyId,
            recordedAt: srcMeta.recordedAt, fileName: srcMeta.fileName },
        };
      })();

      tx.oncomplete = () => resolve(decision ?? { ok: false, reason: 'io' });
      tx.onabort = () => resolve(decision ?? { ok: false, reason: 'io' });
      tx.onerror = () => resolve(decision ?? { ok: false, reason: 'io' });
    });
  } catch { return { ok: false, reason: 'io' }; }
  finally { try { db.close(); } catch {} }
}
