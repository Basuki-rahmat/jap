// Favicon ber-box: browser merender favicon apa adanya (tanpa CSS),
// sehingga box putih + sudut membulat digambar langsung ke dalam PNG.
// 64x64: kanvas putih rounded, logo contain di tengah dengan padding.
const fs = require('fs');
const path = require('path');

const OUT_ABS = path.join(__dirname, '..', 'public', 'img', 'favicon-boxed.png');
const OUT_URL = '/img/favicon-boxed.png';
const SIZE = 64;
const PAD = 9;
const RADIUS = 14;

async function ensureBoxedFavicon(logoUrl) {
  const rel = String(logoUrl || '');
  let srcAbs = null;
  if (rel.startsWith('/img/')) {
    srcAbs = path.join(__dirname, '..', 'public', rel.replace(/^\//, ''));
  }
  if (!srcAbs || !fs.existsSync(srcAbs)) {
    try {
      if (fs.existsSync(OUT_ABS)) fs.unlinkSync(OUT_ABS);
    } catch (e) {}
    return null;
  }
  try {
    const sharp = require('sharp');
    const srcStat = fs.statSync(srcAbs);
    try {
      const outStat = fs.statSync(OUT_ABS);
      if (outStat.mtimeMs >= srcStat.mtimeMs) return OUT_URL; // masih segar
    } catch (e) {}
    // Logo melebar (seperti KNAB) diberi padding lebih kecil agar tetap terbaca di 16px.
    let pad = PAD;
    try {
      const sm = await sharp(srcAbs).metadata();
      if ((sm.width || 1) / (sm.height || 1) > 1.4) pad = 5;
    } catch (e) {}
    const inner = SIZE - pad * 2;
    const logo = await sharp(srcAbs).resize(inner, inner, { fit: 'inside' }).png().toBuffer();
    const meta = await sharp(logo).metadata();
    const left = Math.round((SIZE - (meta.width || inner)) / 2);
    const top = Math.round((SIZE - (meta.height || inner)) / 2);
    await sharp({
      create: { width: SIZE, height: SIZE, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .composite([
        { input: logo, left, top },
        {
          input: Buffer.from(
            `<svg width="${SIZE}" height="${SIZE}"><rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="#fff"/></svg>`
          ),
          blend: 'dest-in',
        },
      ])
      .png()
      .toFile(OUT_ABS);
    return OUT_URL;
  } catch (e) {
    console.error('Boxed favicon error:', e.message);
    return null;
  }
}

module.exports = { ensureBoxedFavicon, BOXED_FAVICON_URL: OUT_URL };
