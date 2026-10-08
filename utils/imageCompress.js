// Kompresi server-side (jaring pengaman; client sudah mengompres duluan).
// Best-effort: gagal kompres = berkas asli tetap dipakai, request tidak gagal.
const fs = require('fs');
const path = require('path');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isImageFile(filename, mimetype) {
  if (mimetype && String(mimetype).startsWith('image/')) return true;
  return IMAGE_EXTS.has(String(path.extname(filename || '')).toLowerCase());
}

async function compressImageFile(absPath, { maxDim = 1280, quality = 78 } = {}) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return { skipped: true };
    const ext = path.extname(absPath).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return { skipped: true };
    const sharp = require('sharp');
    const meta = await sharp(absPath).metadata();
    const st = fs.statSync(absPath);
    const w = meta.width || 0;
    const h = meta.height || 0;
    // Sudah kecil: lewati agar hemat CPU & mutu tetap.
    if (w > 0 && h > 0 && Math.max(w, h) <= maxDim && st.size <= 400 * 1024) {
      return { skipped: true };
    }
    const tmp = absPath + '.cmp' + ext;
    let pipe = sharp(absPath).rotate().resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true });
    if (ext === '.png') pipe = pipe.png({ compressionLevel: 9, quality });
    else if (ext === '.webp') pipe = pipe.webp({ quality });
    else pipe = pipe.jpeg({ quality, mozjpeg: true });
    await pipe.toFile(tmp);
    fs.renameSync(tmp, absPath);
    return { compressed: true };
  } catch (e) {
    try {
      const tmp = absPath + '.cmp' + path.extname(absPath).toLowerCase();
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (err) {}
    console.error('Compress skip:', absPath, e.message);
    return { skipped: true, error: e.message };
  }
}

// Terima: array multer file ({ path, filename, mimetype }) atau path absolut /uploads.
async function compressUploads(files, opts) {
  const list = Array.isArray(files) ? files : [files];
  let done = 0;
  for (const f of list) {
    if (!f) continue;
    const abs = typeof f === 'string'
      ? path.join(__dirname, '..', 'public', String(f).replace(/^\//, ''))
      : (f.path || (f.filename ? path.join(__dirname, '..', 'public', 'uploads', f.filename) : null));
    if (!abs) continue;
    if (f && f.mimetype && !String(f.mimetype).startsWith('image/')) continue;
    const r = await compressImageFile(abs, opts);
    if (r && r.compressed) done += 1;
  }
  return { done };
}

module.exports = { compressImageFile, compressUploads, isImageFile };
