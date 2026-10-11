// Gabung Dokumen Legalitas multi-halaman (maks 5 gambar) menjadi 1 gambar
// JPEG memanjang: halaman ditumpuk berurutan 1, 2, 3, ... ke bawah sesuai
// urutan upload. Dipakai submitLahan (form web + API) dan perbaikan — kolom
// DB tetap 1 path sehingga admin, proposal, dan tampilan lain tidak berubah.
// Satu gambar utuh → proposal & popup admin bisa menampilkannya (PDF dilewati
// proposal). Aturan: >1 berkas harus semuanya gambar (JPG/PNG/WebP); bila
// user sudah punya 1 PDF multi-halaman, unggah PDF itu saja (1 berkas =
// disimpan apa adanya).
const fs = require('fs');
const path = require('path');

const LEGAL_MAX_PAGES = 5;
const STACK_MAX_W = 1240;

// multerFiles: array objek file multer ({ path, filename, mimetype }).
// File harus sudah terurut sesuai urutan upload (multer + picker menjaga ini).
// Return null bila hanya 0-1 berkas (tidak perlu digabung),
// atau { filename, absPath, webPath, pages } bila digabung.
// Throw Error (pesan ramah-user) bila tidak bisa digabung.
async function mergeLegalPages(multerFiles) {
  const files = (multerFiles || []).filter(Boolean);
  if (files.length <= 1) return null;
  if (files.length > LEGAL_MAX_PAGES) {
    throw new Error(`Dokumen legalitas maksimal ${LEGAL_MAX_PAGES} halaman. Kurangi pilihan Anda.`);
  }
  const nonImage = files.find((f) => !String(f.mimetype || '').startsWith('image/'));
  if (nonImage) {
    throw new Error('Untuk multi-halaman, pilih gambar (JPG/PNG/WebP) saja — atau unggah 1 file PDF yang sudah multi-halaman.');
  }
  const sharp = require('sharp');
  const dir = path.dirname(files[0].path);
  const fname = `legal-${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`;
  const abs = path.join(dir, fname);
  try {
    // Normalisasi tiap halaman (lebar maks 1240px, pertahankan rasio).
    const pages = [];
    for (const f of files) {
      const { data, info } = await sharp(f.path).rotate()
        .resize(STACK_MAX_W, null, { withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      pages.push({ data, w: info.width, h: info.height });
    }
    const W = Math.max(...pages.map((p) => p.w));
    const H = pages.reduce((sum, p) => sum + p.h, 0);
    if (!W || !H) throw new Error('gambar tidak terbaca.');
    let top = 0;
    const composite = pages.map((p) => {
      const input = { input: p.data, top, left: Math.floor((W - p.w) / 2) };
      top += p.h;
      return input;
    });
    await sharp({
      create: { width: W, height: H, channels: 3, background: '#ffffff' },
    }).composite(composite).jpeg({ quality: 82 }).toFile(abs);
  } catch (e) {
    try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch (_) {}
    if (e.message && /maksimal|multi-halaman|tidak terbaca/.test(e.message)) throw e;
    throw new Error('Gagal menggabung halaman legalitas: ' + (e.message || e));
  }
  // Hapus file asli agar tidak yatim (best-effort).
  files.forEach((f) => {
    try { fs.unlink(f.path, () => {}); } catch (_) {}
  });
  return { filename: fname, absPath: abs, webPath: '/uploads/' + fname, pages: files.length };
}

module.exports = { mergeLegalPages, LEGAL_MAX_PAGES };
