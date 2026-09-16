'use client';

/**
 * VideoRecorderModal — in-app video capture using getUserMedia +
 * MediaRecorder. Records rear-camera video with microphone audio and
 * hands the resulting Blob back to the parent as a File so the
 * existing upload pipeline can send it through /v1/media/upload-url.
 *
 * Compatibility strategy:
 *   - Feature-detects `navigator.mediaDevices.getUserMedia` and
 *     `MediaRecorder`. If either is missing, or `getUserMedia`
 *     rejects the permission prompt, the modal shows an "استخدم
 *     كاميرا الجهاز" button that triggers a hidden
 *     `<input type="file" accept="video/*" capture="environment">`
 *     — that opens the OS-native camera on iOS Safari and Android.
 *   - Cycles through a short list of candidate MIME types with
 *     `MediaRecorder.isTypeSupported()` and picks the first that
 *     the current browser accepts (mp4 → webm/vp9 → webm/vp8 →
 *     webm). The chosen MIME becomes the File's type.
 *
 * The recorder does NOT auto-start — the user must press "بدء
 * التسجيل" so the browser's mic/camera permission prompt fires only
 * on an explicit click. On stop, the modal shows a preview with
 * "إعادة التصوير" / "رفع الفيديو". Duration counter runs while
 * recording.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const MIME_CANDIDATES = [
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

function pickSupportedMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* ignore */ }
  }
  return null;
}

type Props = {
  onClose: () => void;
  onCaptured: (file: File) => void;
  maxDurationSeconds: number;
};

export function VideoRecorderModal({ onClose, onCaptured, maxDurationSeconds }: Props) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'preview' | 'unsupported' | 'denied'>('idle');
  const [errAr, setErrAr] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fallbackRef = useRef<HTMLInputElement | null>(null);

  const stopTracks = useCallback(() => {
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    stopTracks();
  }, [stopTracks]);

  useEffect(() => () => {
    cleanup();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [cleanup, previewUrl]);

  const start = useCallback(async () => {
    setErrAr(null);
    setSeconds(0);
    const mime = pickSupportedMime();
    if (!navigator.mediaDevices?.getUserMedia || !mime) {
      setPhase('unsupported');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: true,
      });
    } catch {
      setPhase('denied');
      return;
    }
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      await videoRef.current.play().catch(() => { /* autoplay policy — user click already granted */ });
    }
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream, { mimeType: mime }); }
    catch { recorder = new MediaRecorder(stream); }
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mime });
      const url = URL.createObjectURL(blob);
      setRecordedBlob(blob);
      setPreviewUrl(url);
      setPhase('preview');
      stopTracks();
    };
    recorder.start();
    setPhase('recording');
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        const next = s + 1;
        if (next >= maxDurationSeconds) {
          try { recorder.stop(); } catch { /* ignore */ }
        }
        return next;
      });
    }, 1000);
  }, [maxDurationSeconds, stopTracks]);

  const stop = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { recorderRef.current?.stop(); } catch { /* ignore */ }
  }, []);

  const retake = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setRecordedBlob(null);
    setPhase('idle');
    setSeconds(0);
    setErrAr(null);
  }, [previewUrl]);

  const upload = useCallback(() => {
    if (!recordedBlob) return;
    const ext = recordedBlob.type.includes('mp4') ? 'mp4' : 'webm';
    const file = new File([recordedBlob], `capture-${Date.now()}.${ext}`, { type: recordedBlob.type });
    onCaptured(file);
    cleanup();
    onClose();
  }, [recordedBlob, onCaptured, cleanup, onClose]);

  const cancel = useCallback(() => {
    cleanup();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    onClose();
  }, [cleanup, onClose, previewUrl]);

  const openFallback = useCallback(() => fallbackRef.current?.click(), []);
  const fallbackCaptured = useCallback((files: FileList | null) => {
    const f = files?.item(0);
    if (!f) return;
    onCaptured(f);
    cleanup();
    onClose();
  }, [onCaptured, cleanup, onClose]);

  return (
    <>
      <VideoRecorderStyles />
      <div className="vrm-scrim" role="dialog" aria-modal="true" aria-label="تصوير فيديو" dir="rtl">
        <div className="vrm-panel">
          <header className="vrm-head">
            <h3>تصوير فيديو للعقار</h3>
            <button type="button" className="vrm-x" onClick={cancel} aria-label="إغلاق">✕</button>
          </header>

          {phase === 'idle' && (
            <>
              <p className="vrm-hint">سيُطلب منك السماح باستخدام الكاميرا والميكروفون. المدة القصوى {maxDurationSeconds} ثانية.</p>
              <button type="button" className="vrm-btn primary" onClick={start}>ابدأ التصوير</button>
            </>
          )}

          {phase === 'recording' && (
            <>
              <div className="vrm-stage">
                <video ref={videoRef} playsInline muted autoPlay />
                <div className="vrm-rec"><span className="vrm-rec-dot" /> {seconds}s</div>
              </div>
              <button type="button" className="vrm-btn danger" onClick={stop}>إيقاف التسجيل</button>
            </>
          )}

          {phase === 'preview' && previewUrl && (
            <>
              <div className="vrm-stage">
                <video ref={previewRef} src={previewUrl} controls playsInline />
              </div>
              <div className="vrm-row">
                <button type="button" className="vrm-btn" onClick={retake}>إعادة التصوير</button>
                <button type="button" className="vrm-btn primary" onClick={upload}>رفع الفيديو</button>
              </div>
            </>
          )}

          {(phase === 'unsupported' || phase === 'denied') && (
            <>
              <p className="vrm-hint">
                {phase === 'denied'
                  ? 'لم يُمنح إذن الكاميرا/الميكروفون. يمكنك التسجيل من تطبيق الكاميرا مباشرة.'
                  : 'التسجيل داخل التطبيق غير مدعوم على هذا المتصفح. افتح تطبيق الكاميرا لتسجيل الفيديو.'}
              </p>
              <button type="button" className="vrm-btn primary" onClick={openFallback}>استخدم كاميرا الجهاز</button>
              <input
                ref={fallbackRef}
                type="file"
                accept="video/*"
                capture="environment"
                style={{ display: 'none' }}
                onChange={(e) => { fallbackCaptured(e.currentTarget.files); e.currentTarget.value = ''; }}
              />
            </>
          )}

          {errAr && <div role="alert" className="vrm-err">{errAr}</div>}
        </div>
      </div>
    </>
  );
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
        padding: 16px; display: grid; gap: 12px;
        box-shadow: 0 12px 40px rgba(15, 40, 30, 0.25);
        max-height: 90vh; overflow-y: auto;
      }
      .vrm-head { display: flex; align-items: center; justify-content: space-between; }
      .vrm-head h3 { font-size: 17px; font-weight: 800; color: #0F1E18; }
      .vrm-x { border: 1px solid #DEE8E1; background: #F3F6F3; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; font-size: 15px; }
      .vrm-hint { font-size: 13px; color: #4A5A54; }
      .vrm-stage {
        position: relative;
        aspect-ratio: 9 / 16; max-height: 60vh; margin-inline: auto;
        background: #000; border-radius: 12px; overflow: hidden;
      }
      .vrm-stage video { width: 100%; height: 100%; object-fit: cover; display: block; }
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
      .vrm-btn:hover { border-color: #2E9E77; }
      .vrm-btn.primary { background: #2E9E77; color: #fff; border-color: #2E9E77; }
      .vrm-btn.primary:hover { background: #0E7C66; border-color: #0E7C66; }
      .vrm-btn.danger { background: #E13B3B; color: #fff; border-color: #E13B3B; }
      .vrm-btn.danger:hover { background: #B02D2D; }
      .vrm-row { display: flex; gap: 10px; flex-wrap: wrap; }
      .vrm-row .vrm-btn { flex: 1 1 45%; }
      .vrm-err { padding: 10px; border-radius: 10px; background: #f7e2dd; color: #a3341f; font-size: 13px; }
      @media (prefers-reduced-motion: reduce) { .vrm-rec-dot { animation: none; } }
    `}</style>
  );
}
