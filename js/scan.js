// Reads the text off a photo of a bill, on this device. Loaded only when someone taps "Scan bill",
// so it adds nothing to the app's normal start-up. The photo is never uploaded: only the Tesseract
// library and its English language data are downloaded (from a public CDN, then cached by the browser).

const TESSERACT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
let loading = null;

function loadTesseract(){
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!loading) loading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT_SRC; s.async = true;
    s.onload = () => window.Tesseract ? resolve(window.Tesseract) : (loading = null, reject(new Error("The scanner didn't load. Try again.")));
    s.onerror = () => { loading = null; s.remove(); reject(new Error("Couldn't download the scanner. Check your connection and try again.")); };
    document.head.appendChild(s);
  });
  return loading;
}

async function toBitmap(file){
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (e){
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a picture we can read. Try a photo.")); };
      img.src = url;
    });
  }
}

// Phone photos are huge and uneven. Scale to a size the reader handles well, turn it grey, and stretch the
// contrast so faint thermal print stands out from the paper.
async function prepare(file){
  const src = await toBitmap(file);
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw new Error("That file isn't a picture we can read. Try a photo.");
  const scale = Math.min(2, 2000 / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w0 * scale)); c.height = Math.max(1, Math.round(h0 * scale));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4){ const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = g; hist[g]++; }
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++){ acc += hist[v]; if (acc >= total * 0.02){ lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--){ acc += hist[v]; if (acc >= total * 0.02){ hi = v; break; } }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4){
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255 / span) | 0));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// onProgress(status, 0..1) is called while the scanner loads and reads. Resolves to the text found.
export async function readBill(file, onProgress){
  const canvas = await prepare(file);
  const T = await loadTesseract();
  const worker = await T.createWorker("eng", 1, { logger: m => { if (onProgress) onProgress(m.status, m.progress || 0); } });
  try {
    // Mode 4 reads one column of lines of different sizes, which is what a bill is; keeping the gaps
    // between words stops "Paneer Tikka   320.00" from running together.
    await worker.setParameters({ tessedit_pageseg_mode: "4", preserve_interword_spaces: "1" });
    const { data } = await worker.recognize(canvas);
    return (data && data.text) || "";
  } finally {
    try { await worker.terminate(); } catch (e) {}
  }
}
