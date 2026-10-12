/**
 * Proposal PDF pengajuan lahan untuk vendor.
 * Isi: header modern, kartu ringkasan (visual dashboard), peta vektor titik
 * pengajuan di atas poligon resmi Kemendagri (SVG-like, digambar vektor),
 * data calon penyedia, dan lampiran semua dokumen per penyedia.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');

const publicDir = path.join(__dirname, '..', 'public');
const uploadDir = path.join(publicDir, 'uploads');
const TILE_DIR = path.join(os.tmpdir(), 'jap-tiles');

// ---- Poligon resmi Kemendagri (dipakai untuk peta vektor) ----
let GEO = null;
let GEO_BBOX = null;
let MAINLAND_BBOX = null;
try {
  const fc = JSON.parse(fs.readFileSync(path.join(publicDir, 'geojson', 'jabodetabek-kemendagri.json'), 'utf8'));
  GEO = (fc.features || []).filter((f) => f.geometry);
  const span = (list) => {
    let minX = 999, maxX = -999, minY = 999, maxY = -999;
    list.forEach((f) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      polys.forEach((poly) => poly.forEach((ring) => ring.forEach(([x, y]) => {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      })));
    });
    return { minX, maxX, minY, maxY };
  };
  GEO_BBOX = span(GEO);
  // Daratan (tanpa Kep. Seribu yang membentang jauh ke utara) agar peta tidak gepeng
  MAINLAND_BBOX = span(GEO.filter((f) => String(f.properties && f.properties.kode_kemendagri) !== '31.01'));
} catch (e) {
  GEO = null;
}

// ---- Palet Warna Modern (Slate & Emerald Theme) ----
const COLOR_PRIMARY_DARK = '#0f172a'; // Slate 900
const COLOR_PRIMARY = '#1e293b';      // Slate 800
const COLOR_ACCENT = '#059669';       // Emerald 600
const COLOR_ACCENT_BG = '#ecfdf5';    // Emerald 50
const COLOR_ACCENT_BORDER = '#a7f3d0';// Emerald 200

const BLUE = '#2563eb';   // Blue 600
const ORANGE = '#d97706'; // Amber 600
const RED = '#dc2626';    // Red 600
const GRAY = '#64748b';   // Slate 500
const GRAY_LIGHT = '#f8fafc'; // Slate 50
const GRAY_BORDER = '#e2e8f0';// Slate 200
const INK = '#0f172a';    // Slate 900

function parseCoords(mapsLink) {
  const m = String(mapsLink || '').match(/q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { lat, lng };
}

function pip(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function featureContains(f, lng, lat) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some((poly) => poly.length && pip(lng, lat, poly[0]));
}

// Pindah halaman hanya bila sisa ruang tak muat DAN halaman saat ini sudah terisi.
function needSpace(doc, h) {
  const top = doc.page.margins.top;
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (h >= bottom - top) return; // konten lebih tinggi dari halaman: biarkan mengalir
  if (doc.y + h > bottom && doc.y > top + 1) doc.addPage();
}

function sectionTitle(doc, text, opts) {
  if (!text) return;
  needSpace(doc, 40);
  const centered = !!(opts && opts.center);
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.fillColor(COLOR_PRIMARY_DARK).font('Helvetica-Bold').fontSize(10.5);
  
  if (centered) {
    doc.text(text, x0, doc.y, { width: W, align: 'center' });
  } else {
    // Dipastikan benar-benar rata kiri (align: left) di margin x0
    doc.text(text, x0, doc.y, { width: W, align: 'left' });
  }

  const lineY = doc.y + 3;
  doc.moveTo(x0, lineY)
    .lineTo(x0 + W, lineY)
    .strokeColor(GRAY_BORDER)
    .lineWidth(0.8)
    .stroke();
  doc.restore();

  doc.y = lineY + 6;
  doc.fillColor(INK);
}

function statCards(doc, cards) {
  needSpace(doc, 68);
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 8;
  const cw = (W - gap * (cards.length - 1)) / cards.length;
  const h = 58;
  const y = doc.y;

  cards.forEach((c, i) => {
    const x = x0 + i * (cw + gap);
    doc.save();
    doc.roundedRect(x, y, cw, h, 6).fillColor('#ffffff').fill();
    doc.roundedRect(x, y, cw, h, 6).strokeColor(GRAY_BORDER).lineWidth(0.8).stroke();
    doc.roundedRect(x, y, cw, 4, 2).fillColor(c.color || COLOR_ACCENT).fill();
    doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(7).text(c.label.toUpperCase(), x + 8, y + 10, { width: cw - 16 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(c.value, x + 8, y + 23, { width: cw - 16, lineBreak: false, ellipsis: true });
    if (c.sub) doc.fillColor(GRAY).font('Helvetica').fontSize(7.5).text(c.sub, x + 8, y + 39, { width: cw - 16, lineBreak: false, ellipsis: true });
    doc.restore();
  });
  doc.y = y + h + 12;
}

// ---- Background peta OSM (tile 256px, di-cache di folder temp) ----
function lngToX(lng, z) { return (((lng + 180) / 360) * Math.pow(2, z)); }
function latToY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return (((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
}
async function tileBuf(z, x, y) {
  const p = path.join(TILE_DIR, `${z}_${x}_${y}.img`);
  try { return fs.readFileSync(p); } catch (e) { /* belum di-cache */ }
  try {
    if (!fs.existsSync(TILE_DIR)) fs.mkdirSync(TILE_DIR, { recursive: true });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 9000);
    const res = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`, {
      headers: { 'User-Agent': 'JAP-BSS-Proposal/1.0 (admin proposal pdf)' },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpg) return null;
    try { fs.writeFileSync(p, buf); } catch (e) { /* abaikan */ }
    return buf;
  } catch (e) { return null; }
}

async function loadTileLayer(minX, minY, maxX, maxY) {
  let z = 12, tx0 = 0, ty0 = 0, tx1 = -1, ty1 = -1;
  for (; z >= 8; z--) {
    tx0 = Math.floor(lngToX(minX, z)); tx1 = Math.floor(lngToX(maxX, z));
    ty0 = Math.floor(latToY(maxY, z)); ty1 = Math.floor(latToY(minY, z));
    if (tx1 - tx0 + 1 <= 4 && ty1 - ty0 + 1 <= 4) break;
  }
  const tiles = [];
  for (let x = tx0; x <= tx1; x++) {
    for (let y = ty0; y <= ty1; y++) {
      const buf = await tileBuf(z, x, y);
      if (buf) tiles.push({ x, y, buf });
    }
  }
  if (!tiles.length) return null;
  return { z, tx0, ty0, tx1, ty1, tiles };
}

function paintPolys(doc, coords, PX, PY, lineW) {
  GEO.forEach((f) => {
    const col = (f.properties && f.properties.warna) || '#94a3b8';
    const hit = featureContains(f, coords.lng, coords.lat);
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    polys.forEach((poly) => {
      const ring = poly[0];
      if (!ring || ring.length < 3) return;
      doc.save();
      doc.fillOpacity(hit ? 0.45 : 0.15);
      doc.fillColor(col);
      doc.moveTo(PX(ring[0][0]), PY(ring[0][1]));
      for (let i = 1; i < ring.length; i++) doc.lineTo(PX(ring[i][0]), PY(ring[i][1]));
      doc.closePath().fill();
      doc.restore();
      doc.save();
      doc.strokeColor(col).lineWidth(hit ? 1.8 : (lineW || 0.8));
      doc.moveTo(PX(ring[0][0]), PY(ring[0][1]));
      for (let i = 1; i < ring.length; i++) doc.lineTo(PX(ring[i][0]), PY(ring[i][1]));
      doc.closePath().stroke();
      doc.restore();
    });
  });
}

function paintMarker(doc, mx, my) {
  doc.save();
  doc.fillOpacity(1);
  doc.circle(mx, my, 12).fillColor('#fca5a5').fillOpacity(0.35).fill();
  doc.circle(mx, my, 6).fillColor(RED).fillOpacity(1).fill();
  doc.circle(mx, my, 6).strokeColor('#ffffff').lineWidth(1.8).stroke();
  doc.circle(mx, my, 2).fillColor('#ffffff').fill();
  doc.restore();
}

async function drawMap(doc, coords, box) {
  const { x, y, w, h } = box;
  let districtLabel = '';
  doc.save();
  
  doc.roundedRect(x, y, w, h, 6).fillColor('#f8fafc').fill();
  doc.roundedRect(x, y, w, h, 6).strokeColor(GRAY_BORDER).lineWidth(1).stroke();
  doc.roundedRect(x, y, w, h, 6).clip();

  if (GEO && GEO_BBOX && MAINLAND_BBOX && coords) {
    const inSeribu = GEO.some(
      (f) => String(f.properties && f.properties.kode_kemendagri) === '31.01' && featureContains(f, coords.lng, coords.lat)
    );
    const base = inSeribu ? GEO_BBOX : MAINLAND_BBOX;
    const mgn = 0.03;
    const minX = Math.min(base.minX, coords.lng - mgn);
    const maxX = Math.max(base.maxX, coords.lng + mgn);
    const minY = Math.min(base.minY, coords.lat - mgn);
    const maxY = Math.max(base.maxY, coords.lat + mgn);
    const pad = 12;
    let layer = null;
    try { layer = await loadTileLayer(minX, minY, maxX, maxY); } catch (e) { layer = null; }
    if (layer) {
      const totW = (layer.tx1 - layer.tx0 + 1) * 256;
      const totH = (layer.ty1 - layer.ty0 + 1) * 256;
      const s = Math.min((w - pad * 2) / totW, (h - pad * 2) / totH);
      const ts = 256 * s;
      const ox = x + (w - totW * s) / 2;
      const oy = y + (h - totH * s) / 2;
      layer.tiles.forEach((t) => {
        try {
          doc.image(t.buf, ox + (t.x - layer.tx0) * ts, oy + (t.y - layer.ty0) * ts, { width: ts, height: ts });
        } catch (e) { /* tile rusak */ }
      });
      doc.save();
      doc.fillOpacity(0.12);
      doc.fillColor('#ffffff');
      doc.rect(ox, oy, totW * s, totH * s).fill();
      doc.restore();
      const PX = (lng) => ox + (lngToX(lng, layer.z) - layer.tx0) * ts;
      const PY = (lat) => oy + (latToY(lat, layer.z) - layer.ty0) * ts;
      paintPolys(doc, coords, PX, PY, 1);
      paintMarker(doc, PX(coords.lng), PY(coords.lat));
    } else {
      const bw = maxX - minX;
      const bh = maxY - minY;
      const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
      const ox = x + (w - bw * s) / 2;
      const oy = y + (h - bh * s) / 2;
      const PX = (lng) => ox + (lng - minX) * s;
      const PY = (lat) => oy + (maxY - lat) * s;
      paintPolys(doc, coords, PX, PY, 0.8);
      paintMarker(doc, PX(coords.lng), PY(coords.lat));
    }
    const hit = GEO.find((f) => featureContains(f, coords.lng, coords.lat));
    if (hit && hit.properties) districtLabel = `${hit.properties.nama} (${hit.properties.kode_kemendagri})`;
  } else {
    doc.fillColor(GRAY).font('Helvetica').fontSize(9)
      .text('Koordinat / peta wilayah belum tersedia.', x + 12, y + h / 2 - 6, { width: w - 24, align: 'center' });
  }
  doc.restore();
  return districtLabel;
}

function docImageAbs(webPath) {
  if (!webPath) return null;
  const rel = String(webPath).replace(/^\//, '');
  const abs = path.join(publicDir, rel);
  if (!fs.existsSync(abs)) return null;
  if (!/\.(jpe?g|png)$/i.test(abs)) return null;
  return abs;
}

async function measureDocs(doc, items) {
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const out = [];
  for (const { title, webPath, docType } of items) {
    const abs = docImageAbs(webPath);
    if (!abs) continue;
    if (docType === 'ktp') {
      try {
        const sharp = require('sharp');
        const buf = await sharp(abs).rotate().resize(900, 600, { fit: 'cover', position: 'centre' }).jpeg({ quality: 88 }).toBuffer();
        const img = doc.openImage(buf);
        out.push({ title, img, dw: 255, dh: 170, docType });
        continue;
      } catch (e) { /* fallback */ }
    }
    try {
      const img = doc.openImage(abs);
      const lim = { ktp: [350, 220], legal: [W - 24, 480], photo: [W - 24, 350] }[docType] || [W - 24, 350];
      const sc = Math.min(lim[0] / img.width, lim[1] / img.height, 1);
      out.push({
        title,
        img,
        dw: Math.max(1, Math.round(img.width * sc)),
        dh: Math.max(1, Math.round(img.height * sc)),
        docType,
      });
    } catch (e) { /* rusak / tak terbaca */ }
  }
  return out;
}

function renderDocCard(doc, d) {
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cardH = 22 + 8 + d.dh + 10;
  needSpace(doc, cardH);
  const y = doc.y;

  doc.save();
  doc.roundedRect(x0, y, W, cardH, 6).fillColor('#ffffff').fill();
  doc.roundedRect(x0, y, W, cardH, 6).strokeColor(GRAY_BORDER).lineWidth(0.8).stroke();
  doc.roundedRect(x0, y, W, 22, 6).fillColor(COLOR_ACCENT_BG).fill();
  doc.rect(x0, y + 16, W, 6).fillColor(COLOR_ACCENT_BG).fill();
  doc.moveTo(x0, y + 22).lineTo(x0 + W, y + 22).strokeColor(COLOR_ACCENT_BORDER).lineWidth(0.8).stroke();
  doc.fillColor(COLOR_PRIMARY_DARK).font('Helvetica-Bold').fontSize(8.5).text(d.title, x0 + 10, y + 6, { width: W - 20 });
  doc.restore();

  try {
    doc.image(d.img, x0 + (W - d.dw) / 2, y + 28, { width: d.dw, height: d.dh });
  } catch (e) {
    doc.fillColor(RED).font('Helvetica-Oblique').fontSize(8.5).text('Error merender file gambar.', x0 + 12, y + 28, { width: W - 24 });
  }

  doc.y = y + cardH + 10;
  doc.fillColor(INK);
}

function renderLegalFullPage(doc, d) {
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  if (doc.y > doc.page.margins.top + 1) doc.addPage();
  
  doc.fillColor(COLOR_PRIMARY_DARK).font('Helvetica-Bold').fontSize(10.5).text(d.title, { align: 'center' });
  doc.moveDown(0.4);
  
  const yTop = doc.y;
  const maxH = doc.page.height - doc.page.margins.bottom - yTop - 12;
  const sc = Math.min(W / d.img.width, maxH / d.img.height);
  const dw = Math.max(1, Math.round(d.img.width * sc));
  const dh = Math.max(1, Math.round(d.img.height * sc));
  
  try {
    doc.image(d.img, x0 + (W - dw) / 2, yTop, { width: dw, height: dh });
  } catch (e) {
    doc.fillColor(RED).font('Helvetica-Oblique').fontSize(8.5).text('Error merender file gambar.', x0, yTop, { width: W });
  }
  doc.y = yTop + dh + 10;
  doc.fillColor(INK);
}

function renderLampiranDocs(doc, docs, sectionName) {
  const legals = docs.filter((d) => d.docType === 'legal');
  const others = docs.filter((d) => d.docType !== 'legal');
  if (others.length) {
    sectionTitle(doc, sectionName || 'Lampiran Dokumen');
    others.forEach((d) => renderDocCard(doc, d));
  }
  legals.forEach((d) => renderLegalFullPage(doc, d));
}

function statusMeta(status) {
  if (status === 'approved') return { label: 'DISETUJUI', color: COLOR_ACCENT };
  if (status === 'rejected') return { label: 'DITOLAK', color: RED };
  return { label: 'PENDING', color: ORANGE };
}

const ATTACH_DEFS = [
  { key: 'ktp', title: () => 'Fotokopi KTP Pemilik Lahan', get: (L) => L.ktp_file, docType: 'ktp' },
  { key: 'legal', title: () => 'Dokumen Legalitas (SHM/PBB)', get: (L) => L.legal_doc_file, docType: 'legal' },
  { key: 'family', title: () => 'KK / Buku Nikah', get: (L) => L.family_doc_file, docType: 'photo' },
  { key: 'sewa', title: () => 'Surat Sewa', get: (L) => L.sewa_doc_file, docType: 'photo' },
  { key: 'support', title: () => 'Dokumen Pendukung', get: (L) => L.support_doc_file, docType: 'photo' },
  { key: 'foto_sebrang', title: () => 'Foto Sebrang Jalan', get: (L) => L.photo_1_file, docType: 'photo' },
  { key: 'foto_jaringan', title: () => 'Foto Jaringan Listrik', get: (L) => L.photo_3_file, docType: 'photo' },
  { key: 'foto_spot', title: () => 'Foto Penempatan ±3/4 m', get: (L) => L.photo_spot_file, docType: 'photo' },
  { key: 'foto_kanan', title: () => 'Foto Sudut Kanan', get: (L) => L.photo_right_file, docType: 'photo' },
  { key: 'foto_kiri', title: () => 'Foto Sudut Kiri', get: (L) => L.photo_left_file, docType: 'photo' },
  { key: 'foto_selfie', title: () => 'Foto Selfie Pemilik', get: (L) => L.photo_selfie_file, docType: 'photo' },
  { key: 'foto_maps', title: () => 'Screenshot Lokasi & Koordinat', get: (L) => L.photo_maps_file, docType: 'photo' },
];

function unitLampiran(L, enabled, startNo) {
  const items = [];
  let n = startNo || 1;
  ATTACH_DEFS.forEach((d) => {
    if (enabled && enabled.indexOf(d.key) === -1) return;
    const webPath = d.get(L || {});
    if (!webPath) return;
    items.push({ title: `${n}. ${d.title(L || {})}`, webPath, docType: d.docType });
    n += 1;
  });
  return { items, nextNo: n };
}

function renderNotes(doc, notes) {
  if (!notes) return;
  needSpace(doc, 50);
  sectionTitle(doc, 'Catatan Tambahan');
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  
  doc.save();
  doc.fillColor(INK).font('Helvetica').fontSize(8.5).text(notes, x0, doc.y, { width: W, align: 'justify' });
  doc.restore();
  doc.moveDown(0.6);
}

function finishDoc(doc, stream, abs, fname, downloadName, noProposal, ownerName, resolve, reject) {
  const range = doc.bufferedPageRange();
  const fy = doc.page.height - doc.page.margins.bottom - 12;
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.save();
    doc.moveTo(x0, fy - 4).lineTo(x0 + W, fy - 4).strokeColor(GRAY_BORDER).lineWidth(0.5).stroke();
    doc.fillColor(GRAY).font('Helvetica').fontSize(7)
      .text(`Proposal ${noProposal} — ${ownerName || ''} — Dokumen Internal Vendor`, x0, fy, {
        width: W, align: 'left',
      });
    doc.text(`Halaman ${i + 1} dari ${range.count}`, x0, fy, { width: W, align: 'right' });
    doc.restore();
  }
  
  if (doc.bufferedPageRange().count !== range.count) {
    reject(new Error('Halaman bertambah saat pemberian footer.'));
    return;
  }
  doc.end();
  stream.on('finish', () => resolve({ webPath: '/uploads/' + fname, absPath: abs, fileName: downloadName }));
  stream.on('error', reject);
}

function generateProposalPdf(land, marketingName, feeMarketing, slot, brandShort) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const L = land || {};
      const fname = `proposal-${L.id || 'doc'}-${Date.now()}.pdf`;
      const abs = path.join(uploadDir, fname);

      const doc = new PDFDocument({ size: 'A4', margins: { top: 32, right: 36, bottom: 36, left: 36 }, bufferPages: true });
      const stream = fs.createWriteStream(abs);
      doc.pipe(stream);

      let prop = null;
      try { prop = await require('./settings').getProposalSettings(); } catch (e) { prop = null; }
      if (!prop) prop = { contractYears: '5', attachments: null, notes: '', vendorA: 'KNAB', vendorB: 'V-Green' };
      const coBrand = `${prop.vendorA || brandShort || 'BSS'} × ${prop.vendorB || 'V-Green'}`;

      const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const x0 = doc.page.margins.left;
      const now = new Date();
      const tgl = now.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
      const st = statusMeta(L.status);
      const isEvcs = L.unit_type === 'evcs_mobil';
      const unitLabel = isEvcs ? 'EVCS Mobil' : 'BSS Motor';
      const unitSize = isEvcs ? '3 m × 6 m' : '1 m × 1,5 m';
      const coords = parseCoords(L.maps_link);
      const noProposal = `PROP/${L.id || '...'}/${now.getFullYear()}`;

      // ===== Header Modern =====
      const hy = 28;
      const headerH = 82;
      doc.save();
      doc.roundedRect(x0, hy, W, headerH, 8).fillColor(COLOR_PRIMARY_DARK).fill();
      doc.roundedRect(x0, hy, 6, headerH, 3).fillColor(COLOR_ACCENT).fill();

      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text('PROPOSAL PENGAJUAN LAHAN', x0 + 16, hy + 14);
      doc.fillColor('#cbd5e1').font('Helvetica').fontSize(8.5)
        .text(`Battery Swap Station & EV Charging Station  •  ${coBrand} Indonesia`, x0 + 16, hy + 36);
      doc.fillColor('#94a3b8').font('Helvetica').fontSize(8)
        .text(`No. ${noProposal}   •   ${tgl}`, x0 + 16, hy + 52);

      const badge = st.label;
      doc.font('Helvetica-Bold').fontSize(8.5);
      const bw = doc.widthOfString(badge) + 20;
      doc.roundedRect(x0 + W - bw - 14, hy + 14, bw, 22, 11).fillColor(st.color).fill();
      doc.fillColor('#ffffff').text(badge, x0 + W - bw - 14, hy + 20, { width: bw, align: 'center' });
      doc.restore();

      doc.y = hy + headerH + 12;

      // ===== Kartu Ringkasan Dashboard =====
      statCards(doc, [
        { label: 'Jenis Unit', value: unitLabel, sub: unitSize, color: isEvcs ? BLUE : COLOR_ACCENT },
        { label: 'Luas Lahan', value: `${L.area_size || '-'} m²`, sub: L.location_type || '-', color: COLOR_ACCENT },
        { label: 'Sewa / Tahun', value: ' ', sub: `Kontrak ${prop.contractYears} tahun`, color: ORANGE },
        { label: 'Fee Marketing', value: ' ', sub: marketingName || '-', color: BLUE },
      ]);

      // ===== Grid Peta & Data Penyedia =====
      (await (async function mapDataGrid() {
        const mapW = 230;
        const gapX = 14;
        const dataX = x0 + mapW + gapX;
        const dataW = W - mapW - gapX;
        const mapH = 220;
        needSpace(doc, 260);
        const yTop = doc.y;

        const wilayah = await drawMap(doc, coords, { x: x0, y: yTop, w: mapW, h: mapH });
        let ly = yTop + mapH + 6;
        doc.save();
        doc.fillColor(INK).font('Helvetica').fontSize(7.5);
        if (coords) {
          doc.text(`Koordinat: ${coords.lat}, ${coords.lng}`, x0, ly, { width: mapW });
          ly = doc.y + 2;
          if (wilayah) {
            doc.text(`Wilayah: ${wilayah}`, x0, ly, { width: mapW });
            ly = doc.y + 2;
          }
          if (L.maps_link) {
            doc.fillColor(INK).text('Google Maps: ', x0, ly, { width: mapW, continued: true });
            doc.fillColor(BLUE).text('Lihat Tautan Peta', { link: L.maps_link, underline: true });
            ly = doc.y + 2;
          }
        }
        doc.restore();

        let ry = yTop;
        doc.save();
        doc.fillColor(COLOR_PRIMARY_DARK).font('Helvetica-Bold').fontSize(10)
          .text(`Detail Calon Penyedia — ${L.owner_name || '-'}`, dataX, ry, { width: dataW });
        
        ry = doc.y + 4;
        doc.moveTo(dataX, ry).lineTo(dataX + dataW, ry).strokeColor(GRAY_BORDER).lineWidth(0.8).stroke();
        ry += 6;

        const slotCode = slot ? slot.typeCode : (isEvcs ? 'EVCS' : 'BSS');
        const slotTotal = Math.min(10, Math.max(1, Number(L.slot_no) || 1));
        const rows = [
          ['Nama Pemilik', L.owner_name],
          ['Nama Toko', L.shop_name],
          ['NIK', L.nik],
          ['No. HP / WA', L.phone_number],
          ['Slot Unit', `${slotCode} = ${slotTotal} Slot`],
          ['Bank / Rekening', L.bank_name ? `${L.bank_name}${L.account_number ? ' • ' + L.account_number : ''}` : null],
          ['Alamat Pemilik', L.address],
          ['Alamat Lokasi', L.location_address || L.address],
          ['Jenis Lokasi', L.location_type],
          ['Lantai Rata/Cor', L.floor_ready === 'ya' ? 'Ya' : L.floor_ready === 'tidak' ? 'Tidak' : '-'],
          ['Kanopi / Atap', L.has_canopy === 'ya' ? 'Ya' : L.has_canopy === 'tidak' ? 'Tidak' : '-'],
          ['Legalitas', (L.legal_doc_type || '').toUpperCase() || '-'],
          ['Marketing', `${marketingName || '-'}${L.referral_code ? ` (${L.referral_code})` : ''}`],
          ['Tgl Pengajuan', L.created_at ? new Date(L.created_at).toLocaleString('id-ID') : '-'],
        ];

        const lw = 85;
        rows.forEach(([lb, val]) => {
          const v = val || '-';
          const vw = dataW - lw - 6;
          
          doc.font('Helvetica').fontSize(8);
          const lh = doc.heightOfString(lb, { width: lw });
          doc.font('Helvetica-Bold').fontSize(8);
          const vh = doc.heightOfString(v, { width: vw });
          
          doc.fillColor(GRAY).font('Helvetica').fontSize(8).text(lb, dataX, ry, { width: lw });
          doc.fillColor(INK).font('Helvetica-Bold').fontSize(8).text(v, dataX + lw + 6, ry, { width: vw });
          ry += Math.max(lh, vh) + 3;
        });
        doc.restore();

        doc.y = Math.max(ly, ry) + 8;
      })());

      const lamp = unitLampiran(L, prop.attachments, 1);
      const lampiran = await measureDocs(doc, lamp.items);
      renderLampiranDocs(doc, lampiran, 'Lampiran Dokumen');
      renderNotes(doc, prop.notes);

      finishDoc(doc, stream, abs, fname, `proposal-lahan-${L.id || 'doc'}.pdf`, noProposal, L.owner_name, resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function renderOwnerUnit(doc, L, slot, marketingName, prop, lampNo, seen) {
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x0 = doc.page.margins.left;
  const isEvcs = L.unit_type === 'evcs_mobil';
  const unitLabel = isEvcs ? 'EVCS Mobil' : 'BSS Motor';
  const qty = Math.min(10, Math.max(1, Number(L.slot_no) || 1));
  const slotTxt = slot ? `Slot ${slot.typeCode}-${slot.typeSeq}` : '-';
  
  sectionTitle(doc, `${unitLabel} ×${qty} — ${slotTxt}`);
  needSpace(doc, 110);

  const slotCode = slot ? slot.typeCode : (isEvcs ? 'EVCS' : 'BSS');
  const slotTotal = qty;
  const rows = [
    ['Nama Toko', L.shop_name],
    ['Slot Unit', `${slotCode} = ${slotTotal} Slot`],
    ['Marketing', `${marketingName || '-'}${L.referral_code ? ` (${L.referral_code})` : ''}`],
    ['Alamat Lokasi', L.location_address || L.address],
    ['Jenis Lokasi', L.location_type],
    ['Luas Lahan', L.area_size ? `${L.area_size} m²` : '-'],
    ['Lantai / Kanopi', `${L.floor_ready === 'ya' ? 'Rata' : 'Belum'} / ${L.has_canopy === 'ya' ? 'Ada' : 'Tidak'}`],
    ['Legalitas', (L.legal_doc_type || '').toUpperCase() || '-'],
    ['Status', (L.status || '').toUpperCase()],
    ['Tgl Pengajuan', L.created_at ? new Date(L.created_at).toLocaleString('id-ID') : '-'],
  ];

  const lw = 95;
  rows.forEach(([lb, val]) => {
    const v = val || '-';
    const vw = W - lw - 6;
    
    doc.font('Helvetica').fontSize(8);
    const lh = doc.heightOfString(lb, { width: lw });
    doc.font('Helvetica-Bold').fontSize(8);
    const vh = doc.heightOfString(v, { width: vw });
    
    doc.fillColor(GRAY).font('Helvetica').fontSize(8).text(lb, x0, doc.y, { width: lw });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8).text(v, x0 + lw + 6, doc.y, { width: vw });
    doc.y += Math.max(lh, vh) + 2.5;
  });

  doc.fillColor(INK);
  doc.y += 6;

  const coords = parseCoords(L.maps_link);
  needSpace(doc, 200);
  const wilayah = await drawMap(doc, coords, { x: x0, y: doc.y, w: W, h: 180 });
  doc.y += 180 + 6;

  doc.save();
  doc.fillColor(INK).font('Helvetica').fontSize(7.5);
  if (coords) {
    doc.text(`Koordinat: ${coords.lat}, ${coords.lng}`, x0, doc.y, { width: W });
    doc.y += 10;
    if (wilayah) { 
      doc.text(`Wilayah: ${wilayah}`, x0, doc.y, { width: W }); 
      doc.y += 10; 
    }
  }
  doc.restore();

  const lamp = unitLampiran(L, prop.attachments, lampNo);
  const fresh = seen
    ? lamp.items.filter((it) => { if (seen.has(it.webPath)) return false; seen.add(it.webPath); return true; })
    : lamp.items;
  const docs = await measureDocs(doc, fresh);
  renderLampiranDocs(doc, docs, 'Lampiran Dokumen Unit');
  
  return lamp.nextNo;
}

function generateOwnerProposalPdf({ owner, units, slotMap, brandShort, marketingNames }) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const O = owner || {};
      const list = (units || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
      if (!list.length) throw new Error('Tidak ada unit untuk proposal.');
      let prop = null;
      try { prop = await require('./settings').getProposalSettings(); } catch (e) { prop = null; }
      if (!prop) prop = { contractYears: '5', attachments: null, notes: '', vendorA: 'KNAB', vendorB: 'V-Green' };
      const coBrand = `${prop.vendorA || brandShort || 'BSS'} × ${prop.vendorB || 'V-Green'}`;
      const now = new Date();
      const tgl = now.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
      const digits = String(O.phone_number || '').replace(/\D/g, '');
      const noProposal = `PROP/${digits.slice(-6) || '...'}/${now.getFullYear()}`;
      const fname = `proposal-penyedia-${digits.slice(-6) || 'doc'}-${Date.now()}.pdf`;
      const abs = path.join(uploadDir, fname);

      const doc = new PDFDocument({ size: 'A4', margins: { top: 32, right: 36, bottom: 36, left: 36 }, bufferPages: true });
      const stream = fs.createWriteStream(abs);
      doc.pipe(stream);

      const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const x0 = doc.page.margins.left;
      const bss = list.filter((u) => u.unit_type === 'evcs_mobil' ? false : true);
      const evcs = list.filter((u) => u.unit_type === 'evcs_mobil');
      const qtyOf = (u) => Math.min(10, Math.max(1, Number(u.slot_no) || 1));
      const bssQty = bss.reduce((a, u) => a + qtyOf(u), 0);
      const evcsQty = evcs.reduce((a, u) => a + qtyOf(u), 0);

      // ===== Header =====
      const hy = 28;
      const headerH = 82;
      doc.save();
      doc.roundedRect(x0, hy, W, headerH, 8).fillColor(COLOR_PRIMARY_DARK).fill();
      doc.roundedRect(x0, hy, 6, headerH, 3).fillColor(BLUE).fill();

      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text('PROPOSAL PENGAJUAN LAHAN', x0 + 16, hy + 14);
      doc.fillColor('#cbd5e1').font('Helvetica').fontSize(8.5)
        .text(`Battery Swap Station & EV Charging Station  •  ${coBrand} Indonesia`, x0 + 16, hy + 36);
      doc.fillColor('#94a3b8').font('Helvetica').fontSize(8)
        .text(`No. ${noProposal}   •   ${tgl}`, x0 + 16, hy + 52);

      const badge = `${bssQty + evcsQty} UNIT`;
      doc.font('Helvetica-Bold').fontSize(8.5);
      const bw = doc.widthOfString(badge) + 20;
      doc.roundedRect(x0 + W - bw - 14, hy + 14, bw, 22, 11).fillColor(BLUE).fill();
      doc.fillColor('#ffffff').text(badge, x0 + W - bw - 14, hy + 20, { width: bw, align: 'center' });
      doc.restore();

      doc.y = hy + headerH + 12;

      // ===== Dashboard Ringkasan Penyedia =====
      statCards(doc, [
        { label: 'Total Unit', value: String(bssQty + evcsQty), sub: `${bssQty} BSS • ${evcsQty} EVCS`, color: COLOR_ACCENT },
        { label: 'Penyedia', value: (O.owner_name || '-').slice(0, 22), sub: O.phone_number || '', color: BLUE },
        { label: 'Kota', value: (O.city || '-').slice(0, 20), sub: O.district || '', color: COLOR_ACCENT },
        { label: 'Kontrak / Unit', value: `${prop.contractYears} Tahun`, sub: 'Sewa per tahun', color: ORANGE },
      ]);

      // ===== Ringkasan Data Utama Penyedia (Bagian Judul & Rata Kiri di atas Nama Pemilik) =====
      sectionTitle(doc, `Data Penyedia — ${O.owner_name || '-'}`);
      needSpace(doc, 70);
      
      const orows = [
        ['Nama Pemilik', O.owner_name],
        ['NIK', O.nik],
        ['No. HP / WA', O.phone_number],
        ['Bank / Rekening', O.bank_name ? `${O.bank_name}${O.account_number ? ' • ' + O.account_number : ''}` : null],
        ['Alamat Pemilik', O.address],
      ];

      orows.forEach(([lb, val]) => {
        const v = val || '-';
        const vw = W - 100;
        
        doc.font('Helvetica').fontSize(8);
        const lh = doc.heightOfString(lb, { width: 94 });
        doc.font('Helvetica-Bold').fontSize(8);
        const vh = doc.heightOfString(v, { width: vw });
        
        doc.fillColor(GRAY).font('Helvetica').fontSize(8).text(lb, x0, doc.y, { width: 94 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(8).text(v, x0 + 100, doc.y, { width: vw });
        doc.y += Math.max(lh, vh) + 2.5;
      });

      doc.fillColor(INK);
      doc.y += 6;

      // ===== Render Tiap Unit =====
      let lampNo = 1;
      const seenFiles = new Set();
      for (let i = 0; i < list.length; i++) {
        const L = list[i];
        const slot = (slotMap && slotMap[L.id]) || null;
        const mk = (marketingNames && marketingNames[L.marketing_id]) || L.marketing_name || '-';
        lampNo = await renderOwnerUnit(doc, L, slot, mk, prop, lampNo, seenFiles);
      }
      renderNotes(doc, prop.notes);

      finishDoc(doc, stream, abs, fname, `proposal-penyedia-${digits.slice(-6) || 'doc'}.pdf`, noProposal, O.owner_name, resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateProposalPdf, generateOwnerProposalPdf, parseCoords };