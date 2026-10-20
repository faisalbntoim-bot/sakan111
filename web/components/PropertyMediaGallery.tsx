'use client';

/**
 * PropertyMediaGallery — real camera + gallery upload for property images.
 *
 * Two file inputs, each opens the OS-native picker:
 *   - "فتح الكاميرا"  →  capture="environment" so mobile browsers
 *                        offer the rear camera; desktop just opens the
 *                        normal file picker.
 *   - "اختيار من الصور" →  multiple, no capture hint (album picker).
 *
 * Uploads run through lib/media-upload.ts:
 *   1. sha-256 (WebCrypto)
 *   2. POST /v1/media/upload-url
 *   3. PUT bytes with per-file progress (XHR)
 *   4. POST /v1/media to register the MediaAsset
 *
 * The queue keeps the local File in memory during retries so a
 * temporary network drop never loses the picture. A per-item retry
 * button re-runs the pipeline from step 1.
 *
 * Reorder is CLIENT-SIDE only for this iteration. The persisted order
 * would need a small MediaAsset schema addition (`order Int?`) — see
 * the preview report for the deferred proposal.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MediaUploadError, MEDIA_LIMITS, deleteMedia, listMedia, ownerUserId, resolveMediaUrl, setMediaShowcase, uploadOne,
  type MediaAssetRow,
} from '@/lib/media-upload';
import { VideoRecorderModal } from '@/components/VideoRecorderModal';
import {
  savePendingCapture, loadPendingCapture, clearPendingCapture,
  peekGuestCapture, promoteGuestCapture,
  type PendingCapture,
} from '@/lib/pending-capture';

const ACCEPT_IMAGE = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
const ACCEPT_VIDEO = 'video/mp4,video/quicktime,video/webm';
const VIDEO_MAX_DURATION_SECONDS = 180;

type QueueItem = {
  key: string;
  file: File;
  previewUrl: string;
  status: 'pending' | 'uploading' | 'done' | 'error';
  progress: number;       // 0..1
  errorAr: string | null;
  assetId: string | null; // populated on done
};

type Props = { propertyId: string };

export function PropertyMediaGallery({ propertyId }: Props) {
  const [uploaded, setUploaded] = useState<MediaAssetRow[] | null>(null);
  const [order, setOrder] = useState<string[]>([]); // client-side ordering of uploaded ids
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | null>(null);
  const [guestCapture, setGuestCapture] = useState<PendingCapture | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const videoAlbumRef = useRef<HTMLInputElement>(null);
  const galleryGridRef = useRef<HTMLUListElement>(null);

  const reload = useCallback(async () => {
    try {
      const items = await listMedia(propertyId);
      setUploaded(items);
      setOrder((o) => {
        // Merge with existing local order (any newly added id goes to the end).
        const known = new Set(o);
        const added = items.filter((it) => !known.has(it.id)).map((it) => it.id);
        const kept = o.filter((id) => items.some((it) => it.id === id));
        return [...kept, ...added];
      });
      setListErr(null);
    } catch (e) {
      setListErr(e instanceof MediaUploadError ? e.message : 'تعذّر جلب الصور.');
      setUploaded([]);
    }
  }, [propertyId]);

  useEffect(() => { void reload(); }, [reload]);

  // On mount, check whether a prior capture was stashed in IndexedDB
  // for THIS user + THIS property. The userId scope prevents a prior
  // visitor's capture from popping up for the next person who signs
  // in on the same browser.
  useEffect(() => {
    let cancelled = false;
    const uid = ownerUserId();
    if (!uid) return () => { cancelled = true; };
    void loadPendingCapture(uid, propertyId).then((p) => {
      if (!cancelled && p) setPendingCapture(p);
    });
    // Separately: check for a guest-bucket capture left behind before
    // the owner signed in. We surface it as a DIFFERENT banner that
    // requires an explicit "اربطه بحسابي" click — never auto-attach.
    //
    // The guest could have stashed under THIS property's id (they'd
    // bound one in sessionStorage before saving) OR under the generic
    // 'unbound' slot. Check the property-scoped bucket first; fall
    // back to the unbound one so a visitor who recorded without a
    // property gets a chance to attach it after creating one.
    (async () => {
      const scoped = await peekGuestCapture(propertyId);
      if (!cancelled && scoped) { setGuestCapture(scoped); return; }
      const unbound = await peekGuestCapture();
      if (!cancelled && unbound) setGuestCapture(unbound);
    })();
    return () => { cancelled = true; };
  }, [propertyId]);

  // Revoke object URLs on unmount so we don't leak blob memory.
  useEffect(() => () => {
    for (const q of queue) URL.revokeObjectURL(q.previewUrl);
  }, [queue]);

  const startUpload = useCallback((item: QueueItem) => {
    setQueue((q) => q.map((x) => x.key === item.key ? { ...x, status: 'uploading', progress: 0, errorAr: null } : x));
    void uploadOne({
      file: item.file,
      propertyId,
      onProgress: (loaded, total) => {
        setQueue((q) => q.map((x) => x.key === item.key ? { ...x, progress: total > 0 ? loaded / total : 0 } : x));
      },
    })
      .then((row) => {
        setQueue((q) => q.map((x) => x.key === item.key ? { ...x, status: 'done', progress: 1, assetId: row.id } : x));
        // Refresh the uploaded list so the new item appears with a signed URL.
        void reload();
      })
      .catch((e: unknown) => {
        const msg = e instanceof MediaUploadError ? e.message : 'فشل الرفع.';
        setQueue((q) => q.map((x) => x.key === item.key ? { ...x, status: 'error', errorAr: msg } : x));
      });
  }, [propertyId, reload]);

  const enqueueFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const additions: QueueItem[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files.item(i);
      if (!f) continue;
      const key = `${f.name}-${f.size}-${f.lastModified}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      additions.push({
        key, file: f, previewUrl: URL.createObjectURL(f),
        status: 'pending', progress: 0, errorAr: null, assetId: null,
      });
    }
    if (additions.length === 0) return;
    setQueue((q) => [...q, ...additions]);
    // Kick each one immediately in parallel — the backend rate-limit will
    // throttle if we ever exceed the global 200/min.
    for (const item of additions) startUpload(item);
  }, [startUpload]);

  const retry = useCallback((key: string) => {
    setQueue((q) => q.map((x) => x.key === key ? { ...x, status: 'pending', progress: 0, errorAr: null } : x));
    const item = queue.find((x) => x.key === key);
    if (item) startUpload(item);
  }, [queue, startUpload]);

  /**
   * Upload a single File (typically from the in-browser recorder) and
   * resolve ONLY after the backend has confirmed finalize. This is the
   * promise that drives VideoRecorderModal's "جارٍ الحفظ…" → "تم الحفظ"
   * state machine — we never flip the modal to success before the server
   * says the asset is bound to the property.
   *
   * On failure, we throw with a message that the modal's catch block will
   * translate into one of its three categories (session / network /
   * server). We also push an entry into the normal queue so the user can
   * see the progress bar inline with the gallery.
   */
  const uploadVideoAwait = useCallback(async (file: File): Promise<void> => {
    const key = `rec-${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const previewUrl = URL.createObjectURL(file);
    const item: QueueItem = {
      key, file, previewUrl,
      status: 'uploading', progress: 0, errorAr: null, assetId: null,
    };
    setQueue((q) => [...q, item]);
    try {
      const row = await uploadOne({
        file, propertyId,
        onProgress: (loaded, total) => {
          setQueue((q) => q.map((x) => x.key === key ? { ...x, progress: total > 0 ? loaded / total : 0 } : x));
        },
      });
      setQueue((q) => q.map((x) => x.key === key ? { ...x, status: 'done', progress: 1, assetId: row.id } : x));
      await reload();
      // Server-confirmed success: drop any resumable capture so a
      // reload does not re-offer the same file.
      {
        const uid = ownerUserId();
        if (uid) await clearPendingCapture(uid, propertyId);
      }
      setPendingCapture(null);
      setSavedToast('✓ تم حفظ الفيديو في العقار');
      // Toast fades after a few seconds; the gallery row is the real
      // persistent confirmation.
      window.setTimeout(() => setSavedToast(null), 4000);
    } catch (e) {
      setQueue((q) => q.map((x) =>
        x.key === key
          ? { ...x, status: 'error', errorAr: e instanceof MediaUploadError ? e.message : 'فشل الحفظ.' }
          : x,
      ));
      // Session-expiry case: persist the recorded Blob to IndexedDB so
      // the owner can resume after signing in again. Any other error
      // (network/server) is already retriable via the queue entry.
      if (e instanceof MediaUploadError && (e.code === 'AUTH_EXPIRED' || e.code === 'NO_AUTH')) {
        try {
          const uid = ownerUserId();
          if (uid) {
            await savePendingCapture({
              blob: file,
              mimeType: file.type || 'video/webm',
              userId: uid,
              propertyId,
              recordedAt: Date.now(),
              fileName: file.name,
            });
          }
        } catch { /* IDB unavailable — modal still holds the Blob in state */ }
      }
      // Re-throw so the modal's save() catch can render the right message
      // and keep the recorded blob available for retry.
      throw e;
    }
  }, [propertyId, reload]);

  const resumePendingCapture = useCallback(async () => {
    if (!pendingCapture) return;
    const file = new File([pendingCapture.blob], pendingCapture.fileName, {
      type: pendingCapture.mimeType,
    });
    try { await uploadVideoAwait(file); } catch { /* uploadVideoAwait already surfaced error state in the queue */ }
  }, [pendingCapture, uploadVideoAwait]);

  const discardPendingCapture = useCallback(async () => {
    const uid = ownerUserId();
    if (uid) await clearPendingCapture(uid, propertyId);
    setPendingCapture(null);
  }, [propertyId]);

  const attachGuestCapture = useCallback(async () => {
    const uid = ownerUserId();
    if (!uid || !guestCapture) return;
    const sourceProp = guestCapture.propertyId || '';
    const result = await promoteGuestCapture(uid, propertyId, sourceProp);
    if (result.ok) {
      setGuestCapture(null);
      setPendingCapture(result.capture);
      return;
    }
    // promoteGuestCapture failed. The guest row is still intact (that's
    // the atomic contract); surface a specific message per reason so
    // the owner knows what happened and can retry.
    switch (result.reason) {
      case 'existing_user_bucket':
        alert('يوجد لديك بالفعل مقطع بانتظار الحفظ لهذا العقار. تعامل مع المقطع الحالي أولًا ثم أعد المحاولة.');
        break;
      case 'io':
        alert('تعذّر الوصول للتخزين المحلي. أعد المحاولة.');
        break;
      case 'none':
        // The guest bucket vanished between the peek and the promote
        // (e.g. another tab discarded it). Drop the banner silently.
        setGuestCapture(null);
        break;
      case 'bad_input':
        break;
    }
  }, [propertyId, guestCapture]);

  const discardGuestCapture = useCallback(async () => {
    const sourceProp = guestCapture?.propertyId || '';
    await clearPendingCapture('', sourceProp);
    setGuestCapture(null);
  }, [guestCapture]);

  const scrollToGallery = useCallback(() => {
    galleryGridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const dropFromQueue = useCallback((key: string) => {
    setQueue((q) => {
      const drop = q.find((x) => x.key === key);
      if (drop) URL.revokeObjectURL(drop.previewUrl);
      return q.filter((x) => x.key !== key);
    });
  }, []);

  const removeUploaded = useCallback(async (id: string) => {
    try {
      await deleteMedia(id);
      setUploaded((u) => (u ?? []).filter((it) => it.id !== id));
      setOrder((o) => o.filter((x) => x !== id));
      // Also drop any queue entry that matched this asset id.
      setQueue((q) => {
        const drop = q.find((x) => x.assetId === id);
        if (drop) URL.revokeObjectURL(drop.previewUrl);
        return q.filter((x) => x.assetId !== id);
      });
    } catch (e) {
      alert(e instanceof MediaUploadError ? e.message : 'تعذّر حذف الصورة.');
    }
  }, []);

  const toggleShowcase = useCallback(async (id: string, nextPublic: boolean) => {
    try {
      const row = await setMediaShowcase(id, nextPublic);
      setUploaded((u) => (u ?? []).map((it) => it.id === id ? { ...it, visibility: row.visibility } : it));
    } catch (e) {
      alert(e instanceof MediaUploadError ? e.message : 'تعذّر تعديل الإظهار.');
    }
  }, []);

  const move = useCallback((id: string, dir: -1 | 1) => {
    setOrder((o) => {
      const idx = o.indexOf(id);
      if (idx < 0) return o;
      const j = idx + dir;
      if (j < 0 || j >= o.length) return o;
      const copy = o.slice();
      copy.splice(idx, 1);
      copy.splice(j, 0, id);
      return copy;
    });
  }, []);

  const orderedUploaded = ((uploaded ?? []) as MediaAssetRow[])
    .slice()
    .sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      if (ai < 0 && bi < 0) return a.createdAt.localeCompare(b.createdAt);
      if (ai < 0) return 1;
      if (bi < 0) return -1;
      return ai - bi;
    });

  return (
    <>
      <PropertyMediaStyles />
      <div className="pmg" dir="rtl">
        <div className="pmg-hint">
          صوّر العقار مباشرة من الكاميرا، اختر صوراً من الألبوم، أو أضف فيديو قصير.
          الحد للصورة {Math.round(MEDIA_LIMITS.imageMaxBytes / (1024 * 1024))} م.ب،
          وللفيديو {Math.round(MEDIA_LIMITS.videoMaxBytes / (1024 * 1024))} م.ب.
        </div>
        {pendingCapture && (
          <div className="pmg-pending" role="status">
            <div className="pmg-pending-txt">
              يوجد مقطع لم يُحفظ بعد
              {' · '}
              {Math.round(pendingCapture.blob.size / (1024 * 1024) * 10) / 10} م.ب
              {' · '}
              سُجّل {new Date(pendingCapture.recordedAt).toLocaleTimeString('ar-SA')}
            </div>
            <div className="pmg-pending-actions">
              <button type="button" className="pmg-btn primary" onClick={() => void resumePendingCapture()}>
                استكمال الحفظ
              </button>
              <button type="button" className="pmg-btn" onClick={() => void discardPendingCapture()}>
                تجاهل
              </button>
            </div>
          </div>
        )}
        {guestCapture && (
          <div className="pmg-pending" role="dialog" aria-label="موافقة ربط التصوير بالحساب">
            <div className="pmg-pending-txt">
              <strong>تصوير محفوظ قبل تسجيل الدخول</strong>
              {' · '}
              {Math.round(guestCapture.blob.size / (1024 * 1024) * 10) / 10} م.ب
              {' · '}
              سُجّل {new Date(guestCapture.recordedAt).toLocaleTimeString('ar-SA')}
              <br />
              هل تربطه بحسابك الحالي وبهذا العقار؟ لن يُرفع تلقائيًا دون موافقتك.
            </div>
            <div className="pmg-pending-actions">
              <button type="button" className="pmg-btn primary" onClick={() => void attachGuestCapture()}>
                اربطه بحسابي
              </button>
              <button type="button" className="pmg-btn" onClick={() => void discardGuestCapture()}>
                تجاهل الملف
              </button>
            </div>
          </div>
        )}
        <div className="pmg-actions">
          <button type="button" className="pmg-btn primary" onClick={() => cameraRef.current?.click()}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>
            </svg>
            التقاط صورة
          </button>
          <button type="button" className="pmg-btn" onClick={() => albumRef.current?.click()}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="1.5"/><path d="m21 17-6-6-8 8"/>
            </svg>
            اختيار صور
          </button>
          <button type="button" className="pmg-btn" onClick={() => setRecorderOpen(true)}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="6" width="14" height="12" rx="2"/><path d="m17 10 4-2v8l-4-2z"/>
            </svg>
            تصوير فيديو
          </button>
          <button type="button" className="pmg-btn" onClick={() => videoAlbumRef.current?.click()}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 4h12v16H4z"/><path d="m10 9 5 3-5 3z"/>
            </svg>
            اختيار فيديو
          </button>
        </div>

        {/* Hidden inputs — the buttons above trigger these via ref click(). */}
        <input
          ref={cameraRef}
          type="file"
          accept={ACCEPT_IMAGE}
          capture="environment"
          onChange={(e) => { enqueueFiles(e.currentTarget.files); e.currentTarget.value = ''; }}
          style={{ display: 'none' }}
        />
        <input
          ref={albumRef}
          type="file"
          accept={ACCEPT_IMAGE}
          multiple
          onChange={(e) => { enqueueFiles(e.currentTarget.files); e.currentTarget.value = ''; }}
          style={{ display: 'none' }}
        />
        <input
          ref={videoAlbumRef}
          type="file"
          accept={ACCEPT_VIDEO}
          onChange={(e) => { enqueueFiles(e.currentTarget.files); e.currentTarget.value = ''; }}
          style={{ display: 'none' }}
        />

        {recorderOpen && (
          <VideoRecorderModal
            maxDurationSeconds={VIDEO_MAX_DURATION_SECONDS}
            onClose={() => setRecorderOpen(false)}
            onCaptured={uploadVideoAwait}
            onOpenGallery={() => { setRecorderOpen(false); scrollToGallery(); }}
          />
        )}

        {listErr && <div role="alert" className="pmg-alert">{listErr}</div>}
        {savedToast && (
          <div role="status" className="pmg-toast">{savedToast}</div>
        )}

        {(orderedUploaded.length > 0 || queue.length > 0) && (
          <ul className="pmg-grid" ref={galleryGridRef}>
            {orderedUploaded.map((it, i) => {
              const resolved = resolveMediaUrl(it.url);
              const isVideo = it.kind === 'video';
              return (
              <li key={it.id} className="pmg-card">
                <div className="pmg-thumb">
                  {resolved
                    ? (isVideo
                        ? <video src={resolved} controls playsInline preload="metadata" />
                        : <img src={resolved} alt="" loading="lazy" />)
                    : <div className="pmg-thumb-fallback">{isVideo ? 'فيديو' : 'صورة'}</div>}
                  {i === 0 && <span className="pmg-primary" title="الوسيط الرئيسي">رئيسية</span>}
                  {isVideo && <span className="pmg-video-tag" aria-hidden="true">فيديو</span>}
                </div>
                <div className="pmg-row">
                  <button type="button" className="pmg-icon" aria-label="نقل لليسار" onClick={() => move(it.id, -1)}>‹</button>
                  <span className="pmg-idx">{i + 1}</span>
                  <button type="button" className="pmg-icon" aria-label="نقل لليمين" onClick={() => move(it.id, 1)}>›</button>
                  <button type="button" className="pmg-icon danger" aria-label="حذف" onClick={() => void removeUploaded(it.id)}>✕</button>
                </div>
                <label className="pmg-showcase" title="السماح بظهوره على الصفحة الرئيسية بعد اعتماد الإعلان">
                  <input
                    type="checkbox"
                    checked={it.visibility === 'public'}
                    onChange={(e) => void toggleShowcase(it.id, e.target.checked)}
                  />
                  <span>{it.visibility === 'public' ? '🌐 عام' : '🔒 خاص'}</span>
                </label>
              </li>
              );
            })}

            {queue.filter((q) => q.status !== 'done').map((q) => (
              <li key={q.key} className={`pmg-card q-${q.status}`}>
                <div className="pmg-thumb">
                  <img src={q.previewUrl} alt="" />
                  {q.status === 'uploading' && (
                    <div className="pmg-progress"><div className="pmg-progress-fill" style={{ width: `${Math.round(q.progress * 100)}%` }} /></div>
                  )}
                  {q.status === 'error' && q.errorAr && <div className="pmg-err">{q.errorAr}</div>}
                </div>
                <div className="pmg-row">
                  {q.status === 'error'
                    ? <button type="button" className="pmg-icon retry" onClick={() => retry(q.key)}>إعادة</button>
                    : <span className="pmg-idx small">{q.status === 'uploading' ? 'جارٍ الرفع' : 'في الانتظار'}</span>}
                  <button type="button" className="pmg-icon danger" aria-label="إزالة" onClick={() => dropFromQueue(q.key)}>✕</button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {uploaded !== null && orderedUploaded.length === 0 && queue.length === 0 && (
          <div className="pmg-empty">لا توجد صور بعد. ابدأ بإضافة أول صورة.</div>
        )}
      </div>
    </>
  );
}

function PropertyMediaStyles() {
  return (
    <style jsx global>{`
      .pmg { display: grid; gap: 12px; }
      .pmg-hint { font-size: 13px; color: var(--ink-2, #4a463c); }
      .pmg-actions { display: flex; flex-wrap: wrap; gap: 10px; }
      .pmg-btn {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 10px 16px; border-radius: 12px;
        border: 1px solid #DEE8E1; background: #FFFFFF; color: #0F1E18;
        font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
        min-height: 44px;
      }
      .pmg-btn:hover { border-color: #2E9E77; }
      .pmg-btn.primary { background: #2E9E77; color: #fff; border-color: #2E9E77; }
      .pmg-btn.primary:hover { background: #0E7C66; border-color: #0E7C66; }
      .pmg-alert { padding: 10px 12px; border-radius: 10px; background: #f7e2dd; color: #a3341f; font-size: 13px; }
      .pmg-pending {
        display: grid; gap: 10px; padding: 12px 14px;
        border-radius: 14px; border: 1px solid #F2D27A;
        background: #FFF7E0; color: #6B4A00;
      }
      .pmg-pending-txt { font-size: 13.5px; font-weight: 700; }
      .pmg-pending-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .pmg-toast {
        padding: 10px 14px; border-radius: 12px;
        background: #DFF2E8; color: #0E7C66; border: 1px solid #B9E0CC;
        font-size: 13.5px; font-weight: 700;
      }
      .pmg-empty { padding: 32px; text-align: center; color: #6C7B73; border: 1px dashed #DEE8E1; border-radius: 14px; font-size: 13px; }
      .pmg-grid {
        list-style: none; padding: 0; margin: 0;
        display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px;
      }
      .pmg-card {
        display: grid; gap: 6px;
        background: #FFFFFF; border: 1px solid #DEE8E1; border-radius: 14px;
        padding: 8px; box-shadow: 0 2px 10px rgba(15, 40, 30, .05);
      }
      .pmg-card.q-error { border-color: #E1A69A; }
      .pmg-thumb {
        position: relative; aspect-ratio: 1 / 1; overflow: hidden; border-radius: 10px;
        background: #F3F6F3;
      }
      .pmg-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .pmg-thumb-fallback { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: #6C7B73; font-size: 12px; }
      .pmg-primary {
        position: absolute; top: 6px; inset-inline-start: 6px;
        padding: 2px 8px; border-radius: 999px;
        background: #2E9E77; color: #fff; font-size: 10.5px; font-weight: 800;
      }
      .pmg-video-tag {
        position: absolute; top: 6px; inset-inline-end: 6px;
        padding: 2px 8px; border-radius: 999px;
        background: rgba(0, 0, 0, 0.55); color: #fff; font-size: 10.5px; font-weight: 800;
      }
      .pmg-progress {
        position: absolute; inset-inline: 8px; bottom: 8px; height: 4px;
        background: rgba(255,255,255,.4); border-radius: 3px; overflow: hidden;
      }
      .pmg-progress-fill { height: 100%; background: #2E9E77; transition: width .18s ease; }
      .pmg-err {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        background: rgba(163,52,31,.9); color: #fff; text-align: center; padding: 8px; font-size: 12px;
      }
      .pmg-row { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
      .pmg-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; border-radius: 8px;
        border: 1px solid #DEE8E1; background: #FFFFFF; color: #0F1E18;
        font-family: inherit; font-size: 15px; cursor: pointer;
      }
      .pmg-icon:hover { border-color: #2E9E77; color: #2E9E77; }
      .pmg-icon.danger:hover { border-color: #a3341f; color: #a3341f; }
      .pmg-icon.retry { width: auto; padding: 0 10px; font-size: 12px; font-weight: 700; color: #2E9E77; border-color: #2E9E77; }
      .pmg-idx { font-size: 11.5px; color: #6C7B73; font-weight: 700; }
      .pmg-idx.small { font-size: 11px; }
      .pmg-showcase {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 8px; margin-top: 4px;
        font-size: 11.5px; font-weight: 700; color: #4a463c;
        background: #F3F6F3; border: 1px solid #DEE8E1; border-radius: 999px;
        cursor: pointer; user-select: none;
      }
      .pmg-showcase input { accent-color: #2E9E77; }
    `}</style>
  );
}
