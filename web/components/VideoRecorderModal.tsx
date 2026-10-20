'use client';

/**
 * VideoRecorderModal — records a short video from the device camera and
 * returns a File to the parent. v7 keeps the modal open through the save
 * step so the user never loses sight of the upload: the parent now returns
 * a Promise from `onCaptured`, and the modal shows "جارٍ الحفظ…" + a
 * progress-indeterminate state until that promise resolves or rejects.
 *
 * Button labels are explicit (reviewer flagged "استخدام الفيديو" as unclear):
 *   - "حفظ وإضافة للعقار"  → runs onCaptured + waits
 *   - "تنزيل على الجهاز"   → <a download> on an object URL
 *   - "إعادة التصوير"      → discards current blob, re-opens camera
 *
 * No success toast is shown until the server confirms. On failure we keep
 * the blob so the user can retry without re-recording. We never claim
 * "saved to Photos" on iOS — the browser's download API doesn't guarantee
 * album insertion; we only promise the download prompt.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type Phase =
  | 'opening'    // getUserMedia in flight
  | 'ready'      // live preview, waiting for user to press record
  | 'recording'  // MediaRecorder running
  | 'stopping'   // waiting for the final chunk + Blob assembly
  | 'preview'    // recording done, playable preview
  | 'saving'     // onCaptured promise in flight
  | 'saved'      // onCaptured promise resolved — final success state
  | 'error';

type Props = {
  onClose: () => void;
  /** Return a promise so the modal can show saving/success/retry states.
   *  Legacy callers that return void work the same as resolved void. */
  onCaptured: (file: File) => void | Promise<void>;
  maxDurationSeconds: number;
  /** Optional: shown on the saved screen so the user can jump to the
   *  property's media gallery and see the file they just saved. */
  onOpenGallery?: () => void;
};
const MIMES = ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];

export function VideoRecorderModal({ onClose, onCaptured, maxDurationSeconds, onOpenGallery }: Props) {
  const [phase, setPhase] = useState<Phase>('opening');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [url, setUrl] = useState('');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const blob = useRef<Blob | null>(null);
  const objectUrl = useRef('');
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallback = useRef<HTMLInputElement | null>(null);
  const downloadAnchor = useRef<HTMLAnchorElement | null>(null);
  const limit = Number.isFinite(maxDurationSeconds) && maxDurationSeconds > 0 ? maxDurationSeconds : 180;

  const clearTimers = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    if (stopTimer.current) clearTimeout(stopTimer.current);
    timer.current = null; stopTimer.current = null;
  }, []);
  const release = useCallback(() => {
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);
  const cleanup = useCallback(() => {
    generation.current++;
    clearTimers();
    const r = recorder.current;
    recorder.current = null;
    if (r) {
      r.onstop = null; r.ondataavailable = null; r.onerror = null;
      if (r.state !== 'inactive') { try { r.stop(); } catch {} }
    }
    release();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = ''; blob.current = null;
  }, [clearTimers, release]);
  const open = useCallback(async (direction: 'environment' | 'user') => {
    cleanup();
    const ticket = generation.current;
    setPhase('opening'); setError(''); setUrl(''); setSeconds(0);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('التصوير داخل المتصفح غير متاح. استخدم كاميرا الجهاز.'); setPhase('error'); return;
    }
    try {
      let next: MediaStream;
      try {
        next = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: direction }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (e) {
        if ((e as DOMException).name !== 'OverconstrainedError' || ticket !== generation.current) throw e;
        next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: direction } }, audio: true });
      }
      if (ticket !== generation.current) { next.getTracks().forEach(t => t.stop()); return; }
      stream.current = next;
      setPhase('ready');
    } catch (e) {
      if (ticket !== generation.current) return;
      const name = (e as DOMException).name;
      setError(name === 'NotAllowedError' ? 'اسمح باستخدام الكاميرا والميكروفون من إعدادات المتصفح ثم أعد المحاولة.' : name === 'NotReadableError' ? 'الكاميرا مشغولة. أغلق التطبيق الآخر ثم أعد المحاولة.' : 'تعذّر فتح الكاميرا. تأكد من اتصال HTTPS وتوفر الكاميرا والميكروفون.');
      setPhase('error');
    }
  }, [cleanup]);
  useEffect(() => { void open(facing); return cleanup; }, [open, cleanup, facing]);
  // Bind only after React has mounted the live video element.
  useEffect(() => {
    if ((phase === 'ready' || phase === 'recording' || phase === 'stopping') && video.current && stream.current) {
      video.current.srcObject = stream.current;
      void video.current.play().catch(() => setError('اضغط على المعاينة لتشغيلها.'));
    }
  }, [phase]);

  const stop = useCallback(() => {
    const r = recorder.current;
    if (!r || r.state !== 'recording') return;
    clearTimers(); setPhase('stopping');
    stopTimer.current = setTimeout(() => {
      cleanup(); setPhase('error'); setError('تعذّر إكمال ملف الفيديو. أعد التصوير أو استخدم كاميرا الجهاز.');
    }, 10000);
    try { r.stop(); } catch { cleanup(); setPhase('error'); setError('تعذّر إيقاف التسجيل. أعد المحاولة.'); }
  }, [clearTimers, cleanup]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [stop]);
  const start = () => {
    if (phase !== 'ready' || !stream.current || recorder.current) return;
    const ticket = generation.current;
    const parts: Blob[] = [];
    try {
      const mime = MIMES.find(m => MediaRecorder.isTypeSupported(m));
      let r: MediaRecorder;
      try { r = new MediaRecorder(stream.current, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8000000, audioBitsPerSecond: 128000 }); }
      catch { r = new MediaRecorder(stream.current); }
      recorder.current = r;
      let failed = false;
      r.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
      r.onerror = () => { failed = true; };
      r.onstop = () => {
        if (ticket !== generation.current) return;
        clearTimers(); recorder.current = null; release();
        if (failed || !parts.length) { setPhase('error'); setError('لم يكتمل التسجيل. أعد التصوير.'); return; }
        blob.current = new Blob(parts, { type: r.mimeType || parts[0]?.type || 'video/webm' });
        objectUrl.current = URL.createObjectURL(blob.current);
        setUrl(objectUrl.current); setPhase('preview');
      };
      r.start(1000); setPhase('recording'); setError('');
      const started = performance.now();
      timer.current = setInterval(() => {
        const elapsed = (performance.now() - started) / 1000;
        setSeconds(Math.min(limit, Math.floor(elapsed)));
        if (elapsed >= limit) stop();
      }, 200);
    } catch { cleanup(); setPhase('error'); setError('تعذّر بدء التسجيل. استخدم كاميرا الجهاز أو أعد المحاولة.'); }
  };
  const close = () => { cleanup(); onClose(); };

  /** Save-and-upload path. Keeps the modal open; shows "جارٍ الحفظ…"
   *  while the parent's upload promise is in flight; distinguishes between
   *  session-expired / network / server errors by inspecting the thrown
   *  Error's `.message` (parent helper raises AuthoringApiError variants). */
  const save = useCallback(async () => {
    const b = blob.current;
    if (!b) return;
    const file = new File([b], 'capture-' + Date.now() + (b.type.includes('mp4') ? '.mp4' : '.webm'), { type: b.type });
    setPhase('saving'); setError('');
    try {
      await Promise.resolve(onCaptured(file));
      setPhase('saved');
    } catch (e) {
      // Keep the blob so the user can retry without re-recording.
      setPhase('preview');
      const msg = e instanceof Error ? e.message : 'تعذر حفظ الفيديو.';
      // Common status heuristics; the authoring API client throws messages
      // like "انتهت الجلسة" / "تعذّر رفع …". Fall back to a generic hint.
      setError(/جلسة|session/i.test(msg) ? 'انتهت الجلسة — سجّل الدخول ثم أعد الحفظ.'
             : /network|شبكة|فشل الاتصال|TypeError/i.test(msg) ? 'انقطع الاتصال. تأكد من الشبكة وأعد المحاولة.'
             : msg);
    }
  }, [onCaptured]);

  /** Trigger a native "download" prompt on the preview Blob. iOS Safari
   *  can only honour this via a user-initiated anchor click, so we attach
   *  the download attribute and dispatch click() synchronously inside the
   *  button handler. We never claim this "saves to Photos" — the browser
   *  decides where the file goes. */
  const downloadToDevice = useCallback(() => {
    const b = blob.current;
    if (!b || !downloadAnchor.current) return;
    const a = downloadAnchor.current;
    a.href = objectUrl.current;
    a.download = 'capture-' + Date.now() + (b.type.includes('mp4') ? '.mp4' : '.webm');
    a.click();
  }, []);

  const live = phase === 'ready' || phase === 'recording' || phase === 'stopping';
  const previewOrSaving = phase === 'preview' || phase === 'saving';
  return <>
    <VideoRecorderStyles />
    <div className="vrm-scrim" role="dialog" aria-modal="true" aria-label="تصوير فيديو" dir="rtl">
      <div className="vrm-panel">
        <header className="vrm-head">
          <h3>تصوير فيديو للعقار</h3>
          <button type="button" className="vrm-x" onClick={close} aria-label="إغلاق" disabled={phase === 'saving'}>✕</button>
        </header>
        <p className="vrm-hint">المدة القصوى {limit} ثانية. يبدأ التسجيل عند ضغط الزر.</p>

        {phase === 'opening' && <p role="status">جارٍ فتح الكاميرا…</p>}

        {live && <div className="vrm-stage">
          <video ref={video} playsInline muted autoPlay style={{ transform: facing === 'user' ? 'scaleX(-1)' : undefined }} onClick={() => { void video.current?.play().catch(() => {}); }} />
          {phase !== 'ready' && <div className="vrm-rec"><span className="vrm-rec-dot" />{seconds} / {limit} ثانية</div>}
        </div>}

        {phase === 'ready' && <div className="vrm-row">
          <button type="button" className="vrm-btn primary vrm-btn-lg" onClick={start}>بدء التسجيل</button>
          <button type="button" className="vrm-btn" onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')}>تبديل الكاميرا</button>
        </div>}

        {phase === 'recording' && <button type="button" className="vrm-btn danger vrm-btn-lg" onClick={stop}>إيقاف التسجيل</button>}
        {phase === 'stopping' && <p role="status">جارٍ تجهيز الفيديو…</p>}

        {previewOrSaving && <>
          <div className="vrm-stage"><video src={url} controls playsInline /></div>
          {phase === 'saving' && <p role="status" className="vrm-saving">⏳ جارٍ حفظ الفيديو في العقار…</p>}
          <div className="vrm-row">
            <button type="button" className="vrm-btn primary vrm-btn-lg" onClick={save} disabled={phase === 'saving'}>
              {phase === 'saving' ? 'جارٍ الحفظ…' : 'حفظ وإضافة للعقار'}
            </button>
            <button type="button" className="vrm-btn" onClick={downloadToDevice} disabled={phase === 'saving'}>تنزيل على الجهاز</button>
          </div>
          <button type="button" className="vrm-btn vrm-btn-ghost" onClick={() => void open(facing)} disabled={phase === 'saving'}>إعادة التصوير</button>
        </>}

        {phase === 'saved' && <div className="vrm-saved">
          <p role="status" className="vrm-saved-ok">✓ تم حفظ الفيديو في العقار</p>
          <div className="vrm-row">
            {onOpenGallery && <button type="button" className="vrm-btn primary" onClick={() => { onOpenGallery(); close(); }}>عرض معرض العقار</button>}
            <button type="button" className="vrm-btn" onClick={close}>إغلاق</button>
          </div>
        </div>}

        {error && <p role="alert" className="vrm-err">{error}</p>}
        {phase === 'error' && <button type="button" className="vrm-btn" onClick={() => void open(facing)}>إعادة المحاولة</button>}
        {(phase === 'ready' || phase === 'error') && <button type="button" className="vrm-btn vrm-btn-ghost" onClick={() => { cleanup(); setPhase('error'); setError('اختر فيديو من كاميرا الجهاز أو أعد المحاولة.'); fallback.current?.click(); }}>استخدم كاميرا الجهاز</button>}
        <input ref={fallback} type="file" accept="video/*" capture={facing} style={{ display: 'none' }} onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) { blob.current = f; objectUrl.current = URL.createObjectURL(f); setUrl(objectUrl.current); setPhase('preview'); } }} />
        <a ref={downloadAnchor} style={{ display: 'none' }}>تنزيل</a>
      </div>
    </div>
  </>;
}

function VideoRecorderStyles() {
  return (
    <style jsx global>{`
      .vrm-scrim {
        position: fixed; inset: 0; z-index: 1000;
        background: rgba(15, 40, 30, 0.68);
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
      }
      .vrm-panel {
        width: min(560px, 100%);
        background: #FFFFFF; border-radius: 16px;
        padding: 16px calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left));
        display: grid; gap: 12px;
        box-shadow: 0 12px 40px rgba(15, 40, 30, 0.25);
        max-height: 92vh; overflow-y: auto;
      }
      .vrm-head { display: flex; align-items: center; justify-content: space-between; }
      .vrm-head h3 { font-size: 17px; font-weight: 800; color: #0F1E18; }
      .vrm-x { border: 1px solid #DEE8E1; background: #F3F6F3; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; font-size: 15px; }
      .vrm-x:disabled { opacity: .5; cursor: not-allowed; }
      .vrm-hint { font-size: 13px; color: #4A5A54; }
      .vrm-stage {
        position: relative;
        width: min(100%, 340px); aspect-ratio: 9 / 16; max-height: 60vh; margin-inline: auto;
        background: #000; border-radius: 12px; overflow: hidden;
      }
      .vrm-stage video { width: 100%; height: 100%; object-fit: contain; display: block; }
      .vrm-rec {
        position: absolute; top: 10px; inset-inline-start: 10px;
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 10px; border-radius: 999px;
        background: rgba(0, 0, 0, 0.55); color: #fff; font-size: 12px; font-weight: 700;
      }
      .vrm-rec-dot { width: 8px; height: 8px; border-radius: 50%; background: #E13B3B; animation: vrmPulse 1.2s infinite; }
      @keyframes vrmPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
      .vrm-btn {
        padding: 12px 16px; border-radius: 12px;
        border: 1px solid #DEE8E1; background: #FFFFFF; color: #0F1E18;
        font-family: inherit; font-size: 14px; font-weight: 700;
        cursor: pointer; min-height: 44px;
      }
      .vrm-btn:hover:not(:disabled) { border-color: #2E9E77; }
      .vrm-btn:disabled { opacity: .5; cursor: not-allowed; }
      .vrm-btn-lg { font-size: 15px; min-height: 52px; }
      .vrm-btn.primary { background: #2E9E77; color: #fff; border-color: #2E9E77; }
      .vrm-btn.primary:hover:not(:disabled) { background: #0E7C66; border-color: #0E7C66; }
      .vrm-btn.danger { background: #E13B3B; color: #fff; border-color: #E13B3B; }
      .vrm-btn.danger:hover:not(:disabled) { background: #B02D2D; }
      .vrm-btn-ghost { background: transparent; border-style: dashed; }
      .vrm-row { display: flex; gap: 10px; flex-wrap: wrap; }
      .vrm-row .vrm-btn { flex: 1 1 45%; }
      .vrm-err { padding: 10px; border-radius: 10px; background: #f7e2dd; color: #a3341f; font-size: 13px; }
      .vrm-saving { padding: 10px 12px; border-radius: 10px; background: #fff3d4; color: #7a5a00; font-size: 13.5px; font-weight: 600; text-align: center; }
      .vrm-saved { display: grid; gap: 10px; padding: 8px 0; }
      .vrm-saved-ok { padding: 12px; border-radius: 12px; background: #d5efdd; color: #0C4C3A; font-size: 15px; font-weight: 800; text-align: center; }
      @media (prefers-reduced-motion: reduce) { .vrm-rec-dot { animation: none; } }
    `}</style>
  );
}
