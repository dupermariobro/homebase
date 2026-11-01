// Shrink photos on the device before upload: phone cameras produce 5–12 MB files,
// and the tablet only needs ~1920px. Browsers differ in what they can decode
// (notably HEIC and createImageBitmap options on Safari), so decoding falls back
// step by step; if nothing works the caller uploads the original and the server converts it.

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    /* option unsupported — try plain */
  }
  try {
    return await createImageBitmap(file);
  } catch {
    /* fall through to <img> */
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

export async function resizeImage(file, maxSide = 1920, quality = 0.85) {
  const src = await decode(file);
  const sw = src.naturalWidth || src.width;
  const sh = src.naturalHeight || src.height;
  if (!sw || !sh) throw new Error('Could not read that image');
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  src.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob || blob.size < 1000) throw new Error('Could not read that image');
  return blob;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
