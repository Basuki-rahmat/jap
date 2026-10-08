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

const GREEN_DARK = '#14532d';
const GREEN = '#15803d';
const BLUE = '#1d4ed8';
const ORANGE = '#c2410c';
const RED = '#b91c1c';
const GRAY = '#6b7280';
const INK = '#111827';

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
// (tidak pernah membuat halaman kosong: bila kursor masih di atas halaman baru, biarkan mengalir)
function needSpace(doc, h) {
  const top = doc.page.margins.top;
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (h >= bottom - top) return; // konten lebih tinggi dari halaman: biarkan mengalir
  if (doc.y + h > bottom && doc.y > top + 1) doc.addPage();
}

function sectionTitle(doc, text) {
  needSpace(doc, 56); // judul + awal isi tetap sehalaman (anti-judul yatim)
  doc.fillColor(GREEN_DARK).font('Helvetica-Bold').fontSize(12).text(text);
  doc.moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor('#bbf7d0')
    .lineWidth(1.5)
    .stroke();
  doc.moveDown(0.6);
  doc.fillColor(INK);
}

function statCards(doc, cards) {
  needSpace(doc, 72);
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 8;
  const cw = (W - gap * (cards.length - 1)) / cards.length;
  const h = 62;
  const y = doc.y;
  cards.forEach((c, i) => {
    const x = x0 + i * (cw + gap);
    doc.save();
    doc.roundedRect(x, y, cw, h, 8).fillColor('#ffffff').fill();
    doc.roundedRect(x, y, cw, h, 8).strokeColor('#e5e7eb').lineWidth(1).stroke();
    doc.rect(x, y, cw, 5).fillColor(c.color || GREEN).fill();
    doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(7.5).text(c.label.toUpperCase(), x + 8, y + 12, { width: cw - 16 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(c.value, x + 8, y + 28, { width: cw - 16 });
    if (c.sub) doc.fillColor(GRAY).font('Helvetica').fontSize(8).text(c.sub, x + 8, y + 44, { width: cw - 16 });
    doc.restore();
  });
  doc.y = y + h + 10;
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
    // Esri World Street Map (urutan z/y/x); OSM & CARTO memblokir IP hosting (403)
    const res = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`, {
      headers: { 'User-Agent': 'JAP-BSS-Proposal/1.0 (admin proposal pdf)' },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Tolak halaman error (HTML) agar tak ikut ter-cache / ter-embed
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
    if (!isPng && !isJpg) return null;
    try { fs.writeFileSync(p, buf); } catch (e) { /* abaikan */ }
    return buf;
  } catch (e) { return null; }
}
// Muat tile yang menutupi bbox (maks 4x4). null bila offline/gagal.
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
      // Fill poligon
      doc.save();
      doc.fillOpacity(hit ? 0.55 : 0.20);
      doc.fillColor(col);
      doc.moveTo(PX(ring[0][0]), PY(ring[0][1]));
      for (let i = 1; i < ring.length; i++) doc.lineTo(PX(ring[i][0]), PY(ring[i][1]));
      doc.closePath().fill();
      doc.restore();
      // Stroke poligon
      doc.save();
      doc.strokeColor(col).lineWidth(hit ? 2 : (lineW || 0.8));
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
  // Efek shadow / pulse
  doc.circle(mx, my, 14).fillColor('#fca5a5').fillOpacity(0.4).fill();
  // Core marker
  doc.circle(mx, my, 7).fillColor('#dc2626').fillOpacity(1).fill();
  doc.circle(mx, my, 7).strokeColor('#ffffff').lineWidth(2).stroke();
  doc.circle(mx, my, 2.5).fillColor('#ffffff').fill();
  doc.restore();
}

async function drawMap(doc, coords, box) {
  const { x, y, w, h } = box;
  let districtLabel = '';
  doc.save();
  // Background peta
  doc.roundedRect(x, y, w, h, 8).fillColor('#f8fafc').fill();
  doc.roundedRect(x, y, w, h, 8).strokeColor('#cbd5e1').lineWidth(1).stroke();

  // Clip area agar poligon tidak keluar batas kotak
  doc.roundedRect(x, y, w, h, 8).clip();

  if (GEO && GEO_BBOX && MAINLAND_BBOX && coords) {
    // Fokus daratan (tanpa Kep. Seribu) agar peta tidak gepeng;
    // kecuali pengajuan memang di Kep. Seribu. Titik selalu dimuat + margin.
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
      // Jalur utama: background peta OSM + proyeksi mercator sejajar tile
      const totW = (layer.tx1 - layer.tx0 + 1) * 256;
      const totH = (layer.ty1 - layer.ty0 + 1) * 256;
      const s = Math.min((w - pad * 2) / totW, (h - pad * 2) / totH);
      const ts = 256 * s;
      const ox = x + (w - totW * s) / 2;
      const oy = y + (h - totH * s) / 2;
      layer.tiles.forEach((t) => {
        try {
          doc.image(t.buf, ox + (t.x - layer.tx0) * ts, oy + (t.y - layer.ty0) * ts, { width: ts, height: ts });
        } catch (e) { /* tile rusak: lewati */ }
      });
      // Lapisan putih tipis agar poligon & marker terbaca di atas peta
      doc.save();
      doc.fillOpacity(0.16);
      doc.fillColor('#ffffff');
      doc.rect(ox, oy, totW * s, totH * s).fill();
      doc.restore();
      const PX = (lng) => ox + (lngToX(lng, layer.z) - layer.tx0) * ts;
      const PY = (lat) => oy + (latToY(lat, layer.z) - layer.ty0) * ts;
      paintPolys(doc, coords, PX, PY, 1);
      paintMarker(doc, PX(coords.lng), PY(coords.lat));
    } else {
      // Fallback offline: latar polos + proyeksi linear
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
    if (hit && hit.properties) districtLabel = `${hit.properties.nama} (Kemendagri ${hit.properties.kode_kemendagri})`;
  } else {
    doc.fillColor(GRAY).font('Helvetica').fontSize(10)
      .text('Koordinat / peta wilayah belum tersedia.', x + 12, y + h / 2 - 8, { width: w - 24, align: 'center' });
  }
  doc.restore();
  return districtLabel;
}

function docImageAbs(webPath) {
  if (!webPath) return null;
  const rel = String(webPath).replace(/^\//, '');
  const abs = path.join(publicDir, rel);
  if (!fs.existsSync(abs)) return null;
  if (!/\.(jpe?g|png)$/i.test(abs)) return null; // pdfkit: hanya JPEG/PNG
  return abs;
}

// Ukur & saring lampiran: hanya file yang benar-benar ada dan terbaca.
// File yang tidak ada dilewati diam-diam (tanpa halaman/placeholder).
function measureDocs(doc, items) {
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const out = [];
  items.forEach(({ title, webPath, docType }) => {
    const abs = docImageAbs(webPath);
    if (!abs) return;
    try {
      const img = doc.openImage(abs);
      const lim = { ktp: [350, 220], legal: [W - 24, 480], photo: [W - 24, 350] }[docType] || [W - 24, 350];
      const sc = Math.min(lim[0] / img.width, lim[1] / img.height, 1);
      out.push({
        title,
        img,
        dw: Math.max(1, Math.round(img.width * sc)),
        dh: Math.max(1, Math.round(img.height * sc)),
      });
    } catch (e) { /* rusak / tak terbaca: lewati */ }
  });
  return out;
}

// Gambar satu kartu lampiran utuh sehalaman (desain dipertahankan)
function renderDocCard(doc, d) {
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  // Satu kartu utuh sehalaman (page-break-inside: avoid ala referensi HTML)
  needSpace(doc, 20 + 8 + d.dh + 10);
  const y = doc.y;
  // Isi kartu: kepala + gambar
  doc.save();
  doc.roundedRect(x0, y, W, 20, 5).fillColor('#f0fdf4').fill();
  doc.moveTo(x0 + 5, y + 20).lineTo(x0 + W - 5, y + 20).strokeColor('#dcfce7').lineWidth(1).stroke();
  doc.fillColor(GREEN_DARK).font('Helvetica-Bold').fontSize(9.5).text(d.title, x0 + 8, y + 5, { width: W - 16 });
  doc.restore();
  try {
    doc.image(d.img, x0 + (W - d.dw) / 2, y + 28, { width: d.dw, height: d.dh });
  } catch (e) {
    doc.fillColor(RED).font('Helvetica-Oblique').fontSize(9).text('Error merender file gambar.', x0 + 12, y + 28, { width: W - 24 });
  }
  doc.y = y + 28 + d.dh + 10;
  // Bingkai kartu di atas isi
  doc.save();
  doc.roundedRect(x0, y, W, doc.y - y, 8).strokeColor('#e5e7eb').lineWidth(1).stroke();
  doc.restore();
  doc.fillColor(INK);
  doc.y += 8; // jeda antar kartu
}

function statusMeta(status) {
  if (status === 'approved') return { label: 'DISETUJUI', color: GREEN };
  if (status === 'rejected') return { label: 'DITOLAK', color: RED };
  return { label: 'PENDING', color: ORANGE };
}

// Definisi lampiran proposal: key = pilihan di Pengaturan Proposal.
const ATTACH_DEFS = [
  { key: 'ktp', title: () => 'Fotokopi KTP Pemilik Lahan', get: (L) => L.ktp_file, docType: 'ktp' },
  { key: 'legal', title: (L) => `Dokumen Legalitas (${(L.legal_doc_type || '').toUpperCase() || 'SHM/PBB'})`, get: (L) => L.legal_doc_file, docType: 'legal' },
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

// Susun item lampiran satu unit sesuai pilihan pengaturan (dengan penomoran).
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
  needSpace(doc, 60);
  sectionTitle(doc, 'Catatan');
  doc.fillColor(INK).font('Helvetica').fontSize(9).text(notes, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
  doc.moveDown(0.5);
}

function finishDoc(doc, stream, abs, fname, downloadName, noProposal, ownerName, resolve, reject) {
  const range = doc.bufferedPageRange();
  const fy = doc.page.height - doc.page.margins.bottom - 14;
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.fillColor(GRAY).font('Helvetica').fontSize(7.5)
      .text(`Proposal ${noProposal} — ${ownerName || ''} — dokumen internal untuk vendor`, x0, fy, {
        width: W, align: 'center',
      });
    doc.text(`Hal. ${i + 1}/${range.count}`, x0, fy, { width: W, align: 'right' });
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
      // Kebijakan dokumen: nominal sewa & fee TIDAK ditampilkan di proposal vendor.
      const coBrand = (brandShort || 'BSS') + ' × V-Green';
      const fname = `proposal-${L.id || 'doc'}-${Date.now()}.pdf`;
      const abs = path.join(uploadDir, fname);

      const doc = new PDFDocument({ size: 'A4', margins: { top: 36, right: 40, bottom: 44, left: 40 }, bufferPages: true });
      const stream = fs.createWriteStream(abs);
      doc.pipe(stream);

      let prop = null;
      try { prop = await require('./settings').getProposalSettings(); } catch (e) { prop = null; }
      if (!prop) prop = { contractYears: '5', attachments: null, notes: '' };

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

      // ===== Header modern =====
      const hy = 30;
      doc.save();
      doc.roundedRect(x0, hy, W, 92, 10).fillColor(GREEN_DARK).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19).text('PROPOSAL PENGAJUAN LAHAN', x0 + 18, hy + 12);
      doc.fillColor('#bbf7d0').font('Helvetica').fontSize(9.5)
        .text(`Battery Swap Station & EV Charging Station  •  ${coBrand} Indonesia`, x0 + 18, hy + 38);
      doc.fillColor('#ffffff').font('Helvetica').fontSize(9)
        .text(`No. ${noProposal}   •   ${tgl}`, x0 + 18, hy + 56);
      // badge status kanan
      const badge = st.label;
      doc.font('Helvetica-Bold').fontSize(10);
      const bw = doc.widthOfString(badge) + 26;
      doc.roundedRect(x0 + W - bw - 16, hy + 14, bw, 26, 13).fillColor(st.color).fill();
      doc.fillColor('#ffffff').text(badge, x0 + W - bw - 16, hy + 21, { width: bw, align: 'center' });
      doc.restore();
      doc.y = hy + 102;

      // ===== Kartu ringkasan (nominal disembunyikan sesuai kebijakan) =====
      statCards(doc, [
        { label: 'Jenis Unit', value: unitLabel, sub: unitSize, color: isEvcs ? BLUE : GREEN },
        { label: 'Luas Lahan', value: `${L.area_size || '-'} m²`, sub: L.location_type || '', color: GREEN },
        { label: 'Sewa / Tahun / Unit', value: ' ', sub: `Kontrak ${prop.contractYears} tahun`, color: ORANGE },
        { label: 'Fee Marketing', value: ' ', sub: marketingName || '-', color: BLUE },
      ]);

      // ===== Peta + Data berdampingan (mengikuti referensi HTML) =====
      sectionTitle(doc, '');
      
      (await (async function mapDataGrid() {
        const mapW = 240;
        const gapX = 16;
        const dataX = x0 + mapW + gapX;
        const dataW = W - mapW - gapX;
        const mapH = 215;
        needSpace(doc, 300);
        const yTop = doc.y;
        // --- Kolom kiri: peta + info ---
        const wilayah = await drawMap(doc, coords, { x: x0, y: yTop, w: mapW, h: mapH });
        let ly = yTop + mapH + 6;
        doc.fillColor(INK).font('Helvetica').fontSize(8);
        if (coords) {
          doc.text(`Koordinat: ${coords.lat}, ${coords.lng}`, x0, ly, { width: mapW });
          ly = doc.y + 1;
          if (wilayah) {
            doc.text(`Wilayah: ${wilayah}`, x0, ly, { width: mapW });
            ly = doc.y + 1;
          }
          if (L.maps_link) {
            doc.fillColor(INK).font('Helvetica').fontSize(8)
              .text('Google Maps: ', x0, ly, { width: mapW, continued: true });
            doc.fillColor(BLUE).text('Lihat Peta', { link: L.maps_link, underline: true });
            ly = doc.y + 1;
            doc.fillColor(INK);
          }
        } else {
          doc.fillColor(INK);
        }
        // --- Kolom kanan: detail penyedia ---
        let ry = yTop;
        doc.fillColor(GREEN_DARK).font('Helvetica-Bold').fontSize(11)
          .text(`Detail Calon Penyedia — ${L.owner_name || '-'}`, dataX, ry, { width: dataW });
        ry = doc.y + 6;
        const slotTxt = slot ? `Slot ${slot.typeCode}-${slot.typeSeq} dari ${slot.typeTotal}` + (slot.total > 1 ? ` (Unit ke-${slot.seq} dari ${slot.total})` : '') : null;
        const rows = [
          ['Nama Pemilik', L.owner_name],
          ['NIK', L.nik],
          ['No. HP / WA', L.phone_number],
          ...(slotTxt ? [['Slot Unit', slotTxt]] : []),
          ['Bank / No. Rek', L.bank_name ? `${L.bank_name}${L.account_number ? ' • ' + L.account_number : ''}` : null],
          ['Alamat Pemilik', L.address],
          ['Alamat Lokasi', L.location_address || L.address],
          ['Jenis Lokasi', L.location_type],
          ['Lantai Rata / Cor', L.floor_ready === 'ya' ? 'Ya' : L.floor_ready === 'tidak' ? 'Tidak' : '-'],
          ['Kanopi / Atap', L.has_canopy === 'ya' ? 'Ya' : L.has_canopy === 'tidak' ? 'Tidak' : '-'],
          ['Legalitas', (L.legal_doc_type || '').toUpperCase() || '-'],
          ['Marketing', `${marketingName || '-'}${L.referral_code ? ` (${L.referral_code})` : ''}`],
          ['Tanggal Pengajuan', L.created_at ? new Date(L.created_at).toLocaleString('id-ID') : '-'],
        ];
        const lw = 92;
        rows.forEach(([lb, val]) => {
          const v = val || '-';
          const vw = dataW - lw - 6;
          doc.fillColor(GRAY).font('Helvetica').fontSize(9);
          const lh = doc.heightOfString(lb, { width: lw });
          doc.fillColor(INK).font('Helvetica-Bold').fontSize(9);
          const vh = doc.heightOfString(v, { width: vw });
          doc.fillColor(GRAY).font('Helvetica').fontSize(9).text(lb, dataX, ry, { width: lw });
          doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(v, dataX + lw + 6, ry, { width: vw });
          ry += Math.max(lh, vh) + 4;
        });
        doc.fillColor(INK);
        doc.y = Math.max(ly, ry) + 6;
      })());

      // ===== Lampiran dokumen: seksi hanya dibuat bila minimal satu file tersedia =====
      const lamp = unitLampiran(L, prop.attachments, 1);
      const lampiran = measureDocs(doc, lamp.items);
      if (lampiran.length) {
        sectionTitle(doc, 'Lampiran Dokumen');
        lampiran.forEach((d) => renderDocCard(doc, d));
      }
      renderNotes(doc, prop.notes);

      // ===== Footer + nomor halaman (y di dalam area cetak agar tidak memicu halaman baru) =====
      finishDoc(doc, stream, abs, fname, `proposal-lahan-${L.id || 'doc'}.pdf`, noProposal, L.owner_name, resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

// Satu kartu unit (detail + peta + lampiran) untuk proposal gabungan penyedia.
async function renderOwnerUnit(doc, L, slot, marketingName, prop, lampNo) {
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x0 = doc.page.margins.left;
  const isEvcs = L.unit_type === 'evcs_mobil';
  const unitLabel = isEvcs ? 'EVCS Mobil' : 'BSS Motor';
  const slotTxt = slot ? `Slot ${slot.typeCode}-${slot.typeSeq}` : '-';
  sectionTitle(doc, `${unitLabel} — ${slotTxt}`);
  needSpace(doc, 120);
  const rows = [
    ['Marketing', `${marketingName || '-'}${L.referral_code ? ` (${L.referral_code})` : ''}`],
    ['Alamat Lokasi', L.location_address || L.address],
    ['Jenis Lokasi', L.location_type],
    ['Luas', L.area_size ? `${L.area_size} m²` : '-'],
    ['Lantai / Kanopi', `${L.floor_ready === 'ya' ? 'Rata' : 'Belum'} / ${L.has_canopy === 'ya' ? 'Ada' : 'Tidak'}`],
    ['Legalitas', (L.legal_doc_type || '').toUpperCase() || '-'],
    ['Status', (L.status || '').toUpperCase()],
    ['Tanggal Pengajuan', L.created_at ? new Date(L.created_at).toLocaleString('id-ID') : '-'],
  ];
  const lw = 100;
  rows.forEach(([lb, val]) => {
    const v = val || '-';
    const vw = W - lw - 6;
    doc.fillColor(GRAY).font('Helvetica').fontSize(9);
    const lh = doc.heightOfString(lb, { width: lw });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9);
    const vh = doc.heightOfString(v, { width: vw });
    doc.fillColor(GRAY).font('Helvetica').fontSize(9).text(lb, x0, doc.y, { width: lw });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(v, x0 + lw + 6, doc.y, { width: vw });
    doc.y += Math.max(lh, vh) + 3;
  });
  doc.fillColor(INK);
  // Peta titik unit (full-width, ringkas)
  const coords = parseCoords(L.maps_link);
  needSpace(doc, 150);
  const wilayah = await drawMap(doc, coords, { x: x0, y: doc.y, w: W, h: 170 });
  doc.y += 170 + 6;
  doc.fillColor(INK).font('Helvetica').fontSize(8);
  if (coords) {
    doc.text(`Koordinat: ${coords.lat}, ${coords.lng}`, x0, doc.y, { width: W });
    doc.y += 12;
    if (wilayah) { doc.text(`Wilayah: ${wilayah}`, x0, doc.y, { width: W }); doc.y += 12; }
  }
  doc.fillColor(INK);
  // Lampiran unit ini (penomoran berlanjut antar unit)
  const lamp = unitLampiran(L, prop.attachments, lampNo);
  const docs = measureDocs(doc, lamp.items);
  if (docs.length) {
    sectionTitle(doc, 'Lampiran');
    docs.forEach((d) => renderDocCard(doc, d));
  }
  return lamp.nextNo;
}

// Proposal gabungan 1 penyedia: semua unit (BSS 1-4 + EVCS 1-4) dalam satu PDF.
function generateOwnerProposalPdf({ owner, units, slotMap, brandShort, marketingNames }) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const O = owner || {};
      const list = (units || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
      if (!list.length) throw new Error('Tidak ada unit untuk proposal.');
      let prop = null;
      try { prop = await require('./settings').getProposalSettings(); } catch (e) { prop = null; }
      if (!prop) prop = { contractYears: '5', attachments: null, notes: '' };
      const coBrand = (brandShort || 'BSS') + ' × V-Green';
      const now = new Date();
      const tgl = now.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
      const digits = String(O.phone_number || '').replace(/\D/g, '');
      const noProposal = `PROP/${digits.slice(-6) || '...'}/${now.getFullYear()}`;
      const fname = `proposal-penyedia-${digits.slice(-6) || 'doc'}-${Date.now()}.pdf`;
      const abs = path.join(uploadDir, fname);

      const doc = new PDFDocument({ size: 'A4', margins: { top: 36, right: 40, bottom: 44, left: 40 }, bufferPages: true });
      const stream = fs.createWriteStream(abs);
      doc.pipe(stream);

      const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const x0 = doc.page.margins.left;
      const bss = list.filter((u) => u.unit_type === 'evcs_mobil' ? false : true);
      const evcs = list.filter((u) => u.unit_type === 'evcs_mobil');

      // ===== Header =====
      const hy = 30;
      doc.save();
      doc.roundedRect(x0, hy, W, 92, 10).fillColor(GREEN_DARK).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19).text('PROPOSAL PENGAJUAN LAHAN', x0 + 18, hy + 12);
      doc.fillColor('#bbf7d0').font('Helvetica').fontSize(9.5)
        .text(`Battery Swap Station & EV Charging Station  •  ${coBrand} Indonesia`, x0 + 18, hy + 38);
      doc.fillColor('#ffffff').font('Helvetica').fontSize(9)
        .text(`No. ${noProposal}   •   ${tgl}`, x0 + 18, hy + 56);
      const badge = `${list.length} UNIT`;
      doc.font('Helvetica-Bold').fontSize(10);
      const bw = doc.widthOfString(badge) + 26;
      doc.roundedRect(x0 + W - bw - 16, hy + 14, bw, 26, 13).fillColor(BLUE).fill();
      doc.fillColor('#ffffff').text(badge, x0 + W - bw - 16, hy + 21, { width: bw, align: 'center' });
      doc.restore();
      doc.y = hy + 102;

      // ===== Ringkasan penyedia =====
      statCards(doc, [
        { label: 'Total Unit', value: String(list.length), sub: `${bss.length} BSS • ${evcs.length} EVCS`, color: GREEN },
        { label: 'Penyedia', value: (O.owner_name || '-').slice(0, 24), sub: O.phone_number || '', color: BLUE },
        { label: 'Kota', value: (O.city || '-').slice(0, 22), sub: O.district || '', color: GREEN },
        { label: 'Kontrak / Unit', value: `${prop.contractYears} thn`, sub: 'Sewa per tahun', color: ORANGE },
      ]);

      sectionTitle(doc, `Data Penyedia — ${O.owner_name || '-'}`);
      needSpace(doc, 80);
      const orows = [
        ['Nama Pemilik', O.owner_name],
        ['NIK', O.nik],
        ['No. HP / WA', O.phone_number],
        ['Bank / No. Rek', O.bank_name ? `${O.bank_name}${O.account_number ? ' • ' + O.account_number : ''}` : null],
        ['Alamat Pemilik', O.address],
      ];
      orows.forEach(([lb, val]) => {
        const v = val || '-';
        const vw = W - 106;
        doc.fillColor(GRAY).font('Helvetica').fontSize(9);
        const lh = doc.heightOfString(lb, { width: 100 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9);
        const vh = doc.heightOfString(v, { width: vw });
        doc.fillColor(GRAY).font('Helvetica').fontSize(9).text(lb, x0, doc.y, { width: 100 });
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(v, x0 + 106, doc.y, { width: vw });
        doc.y += Math.max(lh, vh) + 3;
      });
      doc.fillColor(INK);
      doc.y += 4;

      // ===== Tiap unit =====
      let lampNo = 1;
      for (let i = 0; i < list.length; i++) {
        const L = list[i];
        const slot = (slotMap && slotMap[L.id]) || null;
        const mk = (marketingNames && marketingNames[L.marketing_id]) || L.marketing_name || '-';
        lampNo = await renderOwnerUnit(doc, L, slot, mk, prop, lampNo);
      }
      renderNotes(doc, prop.notes);

      finishDoc(doc, stream, abs, fname, `proposal-penyedia-${digits.slice(-6) || 'doc'}.pdf`, noProposal, O.owner_name, resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateProposalPdf, generateOwnerProposalPdf, parseCoords };
