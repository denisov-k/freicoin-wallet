// @ts-nocheck — BarcodeDetector нет в lib.dom, jsQR динамический; DOM-каст шумит без пользы
// qr-scan.mjs — сканер QR камерой: полноэкранный оверлей поверх модалки, задняя камера,
// нативный BarcodeDetector где есть (Chrome/Android — быстрее и дешевле), jsQR как фолбэк
// (iOS Safari BarcodeDetector не даёт). Возвращает распознанный текст или null при отмене.
// iOS-грабли учтены: playsinline (иначе видео уходит в фулскрин-плеер), https обязателен.
import { tr } from '@/services/i18n.mjs';

export function scanQr() {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px';
    ov.innerHTML = `
      <video playsinline autoplay muted style="max-width:100%;max-height:75%;border-radius:12px"></video>
      <div style="color:#aaa;font-size:13px" id="qsHint">${tr('point the camera at a QR code')}</div>
      <button id="qsCancel" style="background:#222;color:#fff;border:1px solid #444;border-radius:10px;padding:12px 32px;font-size:15px">${tr('Cancel')}</button>`;
    document.body.appendChild(ov);
    const video = ov.querySelector('video');
    let stream = null, /** @type {any} */ timer = 0, stopped = false;
    const stop = v => {
      if (stopped) return; stopped = true;
      clearInterval(timer);
      try { stream?.getTracks().forEach(t => t.stop()); } catch {}
      ov.remove(); resolve(v);
    };
    ov.querySelector('#qsCancel').onclick = () => stop(null);

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(async s => {
      if (stopped) { s.getTracks().forEach(t => t.stop()); return; }
      stream = s; video.srcObject = s;
      try { await video.play(); } catch {}
      // нативный детектор, если умеет qr_code
      let native = null;
      try {
        if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code'))
          native = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch {}
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let jsqr = null;   // ленивая загрузка фолбэка — нужен только там, где нет BarcodeDetector
      timer = setInterval(async () => {
        if (stopped || !video.videoWidth) return;
        try {
          if (native) {
            const codes = await native.detect(video);
            if (codes.length) return stop(codes[0].rawValue);
          } else {
            jsqr ??= (await import('jsqr')).default;
            const w = Math.min(640, video.videoWidth), h = Math.round(w * video.videoHeight / video.videoWidth);
            canvas.width = w; canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const hit = jsqr(img.data, w, h, { inversionAttempts: 'dontInvert' });
            if (hit?.data) return stop(hit.data);
          }
        } catch { /* один кадр не распознался — пробуем следующий */ }
      }, 180);
    }).catch(() => {
      const hint = ov.querySelector('#qsHint');
      if (hint) hint.textContent = tr('camera unavailable — check the site permission');
      setTimeout(() => stop(null), 2500);
    });
  });
}
