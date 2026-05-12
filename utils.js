// Shared utilities used by both the search page and the create page.
// Kept tiny and DOM-free so it can load before any page-specific UI.

window.Printoken = window.Printoken || {};

window.Printoken.PAPER_MM = { '53': 53, '80': 80, 'custom-mtg': 63 };

// Image → 1-bit B&W with chosen algorithm. Single entry point so callers
// don't have to know about the implementation per algorithm.
//
// opts:
//   algorithm: 'none' (default — let the printer app do its own dithering)
//              | 'atkinson' | 'floyd' | 'threshold'
//   threshold: 0–255, default 128. Lower = darker output.
//   sharpen:   boolean, default false. Unsharp pass before dithering.
window.Printoken.ditherImage = function ditherImage(imageData, opts = {}) {
  const algorithm = opts.algorithm || 'none';
  if (algorithm === 'none') return; // pass-through; preserve original pixels
  const threshold = opts.threshold == null ? 128 : opts.threshold;
  const sharpen = opts.sharpen === true;

  const { data, width: w, height: h } = imageData;
  // 1. Convert to grayscale Float32 (alpha → fade-to-white).
  const gray = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const a = data[i + 3] / 255;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[j] = a * lum + (1 - a) * 255;
  }

  // 2. Optional sharpen (3×3 Laplacian unsharp). Helps thin strokes survive dither.
  if (sharpen) sharpenInPlace(gray, w, h);

  // 3. Dither.
  if (algorithm === 'floyd') floydSteinberg(gray, w, h, threshold);
  else if (algorithm === 'threshold') hardThreshold(gray, w, h, threshold);
  else atkinson(gray, w, h, threshold);

  // 4. Write back.
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const v = gray[j] | 0;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
};

// Backwards-compat: the existing renderer uses floydSteinberg directly.
window.Printoken.floydSteinberg = function (imageData) {
  window.Printoken.ditherImage(imageData, { algorithm: 'floyd', sharpen: false });
};

function sharpenInPlace(gray, w, h) {
  // Light unsharp: kernel [[0,-1,0],[-1,5,-1],[0,-1,0]], clipped to [0,255].
  const out = new Float32Array(gray.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = y * w + x;
      const c = gray[j];
      const u = y > 0 ? gray[j - w] : c;
      const d = y < h - 1 ? gray[j + w] : c;
      const l = x > 0 ? gray[j - 1] : c;
      const r = x < w - 1 ? gray[j + 1] : c;
      let v = 5 * c - (u + d + l + r);
      if (v < 0) v = 0; else if (v > 255) v = 255;
      out[j] = v;
    }
  }
  gray.set(out);
}

function floydSteinberg(gray, w, h, threshold) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = y * w + x;
      const old = gray[j];
      const nw = old < threshold ? 0 : 255;
      const err = old - nw;
      gray[j] = nw;
      if (x + 1 < w)            gray[j + 1]     += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0)              gray[j + w - 1] += err * 3 / 16;
                                gray[j + w]     += err * 5 / 16;
        if (x + 1 < w)          gray[j + w + 1] += err * 1 / 16;
      }
    }
  }
}

// Atkinson — lighter, cleaner output than Floyd. Diffuses 6/8 of the error.
function atkinson(gray, w, h, threshold) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = y * w + x;
      const old = gray[j];
      const nw = old < threshold ? 0 : 255;
      const err = (old - nw) / 8;
      gray[j] = nw;
      if (x + 1 < w)            gray[j + 1]         += err;
      if (x + 2 < w)            gray[j + 2]         += err;
      if (y + 1 < h) {
        if (x > 0)              gray[j + w - 1]     += err;
                                gray[j + w]         += err;
        if (x + 1 < w)          gray[j + w + 1]     += err;
      }
      if (y + 2 < h)            gray[j + 2 * w]     += err;
    }
  }
}

function hardThreshold(gray, w, h, threshold) {
  for (let i = 0; i < gray.length; i++) gray[i] = gray[i] < threshold ? 0 : 255;
}

// Share or download a canvas as a PNG. We try Web Share first (so iOS users
// get the share sheet → AirDrop / printer app / Files), but many non-Safari
// iOS browsers (Brave, Chrome, Firefox) under-report file-share support via
// canShare. So we attempt share() even if canShare says no, and only fall
// back to download if share() throws or rejects with something other than
// AbortError (user-cancelled).
window.Printoken.shareCanvas = function shareCanvas(canvas, name) {
  const safe = (name || 'token').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'token';
  canvas.toBlob(async blob => {
    if (!blob) return;
    const file = new File([blob], `${safe}.png`, { type: 'image/png' });
    if (navigator.share) {
      try {
        await navigator.share({ files: [file], title: safe });
        return;
      } catch (err) {
        // AbortError = user dismissed the share sheet. Don't fall back —
        // they didn't want to save.
        if (err && err.name === 'AbortError') return;
        // Anything else (NotAllowedError, TypeError when files unsupported)
        // → fall through to download.
        console.warn('share failed, falling back to download', err);
      }
    }
    download(blob, safe);
  }, 'image/png');
};

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
