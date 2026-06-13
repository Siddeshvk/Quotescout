/**
 * QuoteScout — public/ocr.js
 * Client-side OCR for scanned-drawing RFQs (blueprint pillar 2).
 *
 * WHY CLIENT-SIDE: the scan is OCR'd in the user's browser with Tesseract.js
 * (pure JS/WASM). The image never leaves the machine (privacy), and only the
 * small extracted-text JSON goes to the server — which sidesteps Vercel's
 * ~4.5 MB request-body limit that a high-res drawing scan would blow past.
 *
 * SCOPE / HONESTY: this CAPTURES text, it does not structure it. Engineering
 * drawings (GD&T symbols, rotated callouts, dense tables, stamp boxes) OCR
 * poorly — 95–99% on clean print, much worse here. So OCR text must always be
 * treated as LOWER-confidence than native CAD/STEP parsing and cross-checked
 * against the drawing. analyze.js should pass it to the model tagged as
 * OCR-derived, and rules that key off OCR'd dimensions should carry lower
 * confidence (lib/rules.js already does this when units/values are uncertain).
 *
 * USAGE (browser, no bundler):
 *   <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
 *   <script type="module">
 *     import { runOcr } from './ocr.js';
 *     const result = await runOcr(file, { onProgress: p => ... });
 *   </script>
 * Also attached as window.QuoteScoutOCR for plain (non-module) scripts.
 *
 * Pure helpers (cleanText, assessOcr) are exported and unit-tested in Node;
 * the canvas/Tesseract path is browser-only and validated on the test page.
 */

export const OCR_VERSION = '1.0.0';

const LOW_CONFIDENCE = 60;     // mean word confidence below this => flag as unreliable
const MIN_WORDS = 3;           // almost-empty result => something went wrong / blank scan
const UPSCALE_BELOW_PX = 1000; // upscale the long edge of small images up to ~1500px

/* ----------------------------- pure helpers (no DOM) ----------------------------- */

/** Normalise OCR text: unify newlines, trim lines, collapse blank runs. Keeps all content. */
export function cleanText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Turn a raw Tesseract result into a structured, honestly-caveated assessment.
 * @param {{text:string, confidence:number}} data  // confidence is 0–100
 */
export function assessOcr(data = {}) {
  const text = cleanText(data.text);
  const meanConfidence = Math.round(Number.isFinite(data.confidence) ? data.confidence : 0);
  const wordCount = text ? (text.match(/\S+/g) || []).length : 0;
  const warnings = [];

  if (wordCount < MIN_WORDS) {
    warnings.push('Almost no text was recognized — the image may be blank, very low-resolution, or not actually a drawing.');
  }
  if (meanConfidence < LOW_CONFIDENCE) {
    warnings.push(`OCR confidence is low (${meanConfidence}%). Treat the extracted text as unverified.`);
  }
  // always present — the standing caveat
  warnings.push('OCR text is lower-confidence than native CAD parsing. Engineering drawings with GD&T symbols, rotated text, or dense tables transcribe imperfectly — cross-check every dimension against the drawing before quoting.');

  return {
    text,
    meanConfidence,
    wordCount,
    lowConfidence: meanConfidence < LOW_CONFIDENCE || wordCount < MIN_WORDS,
    warnings,
  };
}

/* ----------------------------- browser-only path ----------------------------- */

/** Decode + preprocess an image File/Blob to a canvas (grayscale + contrast stretch + gentle upscale). */
async function preprocessToCanvas(file, opts = {}) {
  const { grayscale = true, contrast = true } = opts;
  if (typeof document === 'undefined') throw new Error('preprocessToCanvas requires a browser DOM.');

  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  const longest = Math.max(width, height) || 1;
  const scale = longest < UPSCALE_BELOW_PX ? Math.min(2, 1500 / longest) : 1;
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === 'function') bitmap.close();

  if (grayscale || contrast) {
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;

    // luma + percentile-based contrast bounds (robust to a few black/white outliers)
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = y; // grayscale in place
      hist[y]++;
    }
    let lo = 0, hi = 255;
    if (contrast) {
      const total = width * height;
      const cut = Math.max(1, Math.floor(total * 0.02));
      let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cut) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cut) { hi = v; break; } }
      if (hi - lo < 16) { lo = 0; hi = 255; } // degenerate — skip stretch
      const range = hi - lo || 1;
      for (let i = 0; i < d.length; i += 4) {
        let v = (d[i] - lo) * 255 / range;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return canvas;
}

/**
 * Run OCR on an image File/Blob in the browser.
 * @param {File|Blob} file
 * @param {object} [opts]
 * @param {(progress:number, status:string)=>void} [opts.onProgress] 0..1
 * @param {string}  [opts.lang='eng']
 * @param {boolean} [opts.preprocess=true]
 * @returns {Promise<{text,meanConfidence,wordCount,lowConfidence,warnings,durationMs}>}
 */
export async function runOcr(file, opts = {}) {
  const { onProgress, lang = 'eng', preprocess = true } = opts;
  if (typeof Tesseract === 'undefined') {
    throw new Error('Tesseract.js is not loaded. Add the tesseract.js script tag before calling runOcr().');
  }
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const image = preprocess ? await preprocessToCanvas(file, opts) : file;

  const worker = await Tesseract.createWorker(lang, 1, {
    logger: (m) => {
      if (onProgress && m && typeof m.progress === 'number') onProgress(m.progress, m.status || '');
    },
  });
  try {
    const { data } = await worker.recognize(image);
    const out = assessOcr(data);
    out.durationMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    return out;
  } finally {
    await worker.terminate();
  }
}

export default { runOcr, cleanText, assessOcr, OCR_VERSION };

/* convenience global for plain-script (non-module) consumers like a legacy app.html */
if (typeof window !== 'undefined') {
  window.QuoteScoutOCR = { runOcr, cleanText, assessOcr, OCR_VERSION };
}
