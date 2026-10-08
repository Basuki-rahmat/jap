const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { get, insert, query } = require('../models/db');
const uploadFields = require('../config/upload');

// Proxy geocode Nominatim (server-side) — browser sering kena blokir CORS / 429
// bila menembak Nominatim langsung. Server memakai User-Agent resmi + cache memori.
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const NOMINATIM_UA = 'BSS-Lahan/1.0 (pengajuan-lahan; contact: admin)';
const geoCache = new Map(); // key -> { exp, data }
const geoInflight = new Map(); // key -> Promise (single-flight: request bareng = 1x hit upstream)
function geoCacheGet(key) {
  const hit = geoCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { geoCache.delete(key); return null; }
  return hit.data;
}
function geoCacheSet(key, data, ttlMs) {
  if (geoCache.size > 2000) {
    const oldest = geoCache.keys().next();
    if (!oldest.done) geoCache.delete(oldest.value);
  }
  geoCache.set(key, { exp: Date.now() + ttlMs, data });
}
async function nominatimFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': NOMINATIM_UA, Accept: 'application/json', 'Accept-Language': 'id' },
    });
    if (!r.ok) {
      const err = new Error('Nominatim HTTP ' + r.status);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Reverse geocode: ?lat=-6.2&lon=106.8 -> jsonv2 Nominatim (display_name + address)
router.get('/api/reverse', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ ok: false, error: 'Koordinat tidak valid.' });
  }
  const key = 'rev:' + lat.toFixed(5) + ',' + lon.toFixed(5);
  const hit = geoCacheGet(key);
  if (hit) return res.json(hit);
  try {
    let p = geoInflight.get(key);
    if (!p) {
      p = nominatimFetch(
        `${NOMINATIM_BASE}/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`
      );
      geoInflight.set(key, p);
      p.then(
        (data) => { geoCacheSet(key, data, 12 * 60 * 60 * 1000); geoInflight.delete(key); },
        () => { geoInflight.delete(key); }
      );
    }
    const data = await p;
    res.json(data);
  } catch (err) {
    const code = err && err.status === 429 ? 429 : 502;
    res.status(code).json({ ok: false, error: 'Layanan alamat sibuk. Silakan ketik manual.' });
  }
});

// Forward search untuk kotak pencarian peta: ?q=jl+sudirman -> array Nominatim (maks 6, Indonesia)
router.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (q.length < 3) return res.status(400).json({ ok: false, error: 'Kata kunci minimal 3 huruf.' });
  const key = 'src:' + q.toLowerCase();
  const hit = geoCacheGet(key);
  if (hit) return res.json(hit);
  try {
    let p = geoInflight.get(key);
    if (!p) {
      p = nominatimFetch(
        `${NOMINATIM_BASE}/search?format=jsonv2&limit=6&countrycodes=id&q=${encodeURIComponent(q)}`
      );
      geoInflight.set(key, p);
      p.then(
        (data) => { geoCacheSet(key, data, 60 * 60 * 1000); geoInflight.delete(key); },
        () => { geoInflight.delete(key); }
      );
    }
    const data = await p;
    res.json(data);
  } catch (err) {
    const code = err && err.status === 429 ? 429 : 502;
    res.status(code).json({ ok: false, error: 'Pencarian alamat sibuk. Coba lagi.' });
  }
});

// ---- Database wilayah Jabodetabek (Kota -> Kecamatan -> Kelurahan) ----
// Sumber: API wilayah Indonesia, di-proxy + cache (hemat limit, anti CORS).
const WILAYAH_BASE = 'https://emsifa.github.io/api-wilayah-indonesia/api';
const WILAYAH_UA = 'BSS-Lahan/1.0 (wilayah-jabodetabek)';
const KOTA_JABODETABEK = [
  'Bekasi', 'Bogor', 'Depok',
  'Jakarta Barat', 'Jakarta Pusat', 'Jakarta Selatan', 'Jakarta Timur', 'Jakarta Utara',
  'Kab. Bekasi', 'Kab. Bogor', 'Kab. Tangerang',
  'Tangerang', 'Tangerang Selatan',
];
const WILAYAH_PROVINSI = ['31', '32', '36']; // DKI Jakarta, Jawa Barat, Banten

async function wilayahFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': WILAYAH_UA, Accept: 'application/json' },
    });
    if (!r.ok) {
      const err = new Error('Wilayah HTTP ' + r.status);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function titleCaseWilayah(s) {
  return String(s || '').toLowerCase().replace(/(?:^|[\s-])(\S)/g, (m) => m.toUpperCase());
}

function normWilayahSrv(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

// Cocok longgar: sama persis, atau salah satu mengandung yang lain (min. 5 huruf).
function fuzzyWilayahSrv(a, b) {
  const na = normWilayahSrv(a);
  const nb = normWilayahSrv(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (Math.min(na.length, nb.length) < 5) return false;
  return na.includes(nb) || nb.includes(na);
}

// Cari kode kabupaten/kota dari label form (bedakan Kab. vs Kota).
async function resolveRegencyCode(kotaLabel) {
  let lists = geoCacheGet('regs_all');
  if (!lists) {
    let p = geoInflight.get('regs_all');
    if (!p) {
      p = (async () => {
        const out = [];
        for (const prov of WILAYAH_PROVINSI) {
          const arr = await wilayahFetch(`${WILAYAH_BASE}/regencies/${prov}.json`);
          (arr || []).forEach((r) => out.push({ code: String(r.id), name: String(r.name) }));
        }
        return out;
      })();
      geoInflight.set('regs_all', p);
      p.then(
        (d) => { geoCacheSet('regs_all', d, 30 * 24 * 3600 * 1000); geoInflight.delete('regs_all'); },
        () => { geoInflight.delete('regs_all'); }
      );
    }
    lists = await p;
  }
  const wantKab = /^\s*kab\.?\s/i.test(kotaLabel || '');
  const base = String(kotaLabel || '').replace(/^\s*(kab\.?|kota(\s+administrasi)?)\s*/i, '').trim().toLowerCase();
  const hit = (lists || []).find((r) => {
    const nm = String(r.name || '').toLowerCase();
    const isKab = /kabupaten/.test(nm);
    if (!!isKab !== !!wantKab) return false;
    return nm.replace(/^(kabupaten|kota(\s+administrasi)?)\s+/, '').trim() === base;
  });
  return hit ? hit.code : null;
}

async function cachedWilayah(key, ttlMs, loader) {
  let data = geoCacheGet(key);
  if (data) return data;
  let p = geoInflight.get(key);
  if (!p) {
    p = loader();
    geoInflight.set(key, p);
    p.then(
      (d) => { geoCacheSet(key, d, ttlMs); geoInflight.delete(key); },
      () => { geoInflight.delete(key); }
    );
  }
  return p;
}

router.get('/api/wilayah/kota', (req, res) => {
  res.json({ items: KOTA_JABODETABEK });
});

router.get('/api/wilayah/kecamatan', async (req, res) => {
  const kota = String(req.query.kota || '').slice(0, 100);
  if (!KOTA_JABODETABEK.includes(kota)) {
    return res.status(400).json({ ok: false, error: 'Kota tidak dikenal.' });
  }
  try {
    const code = await resolveRegencyCode(kota);
    if (!code) return res.status(404).json({ ok: false, error: 'Kode wilayah tidak ditemukan.' });
    const items = await cachedWilayah(
      'kec:' + code, 7 * 24 * 3600 * 1000,
      () => wilayahFetch(`${WILAYAH_BASE}/districts/${encodeURIComponent(code)}.json`)
    );
    res.json({ items: (items || []).map((d) => ({ code: String(d.id), name: titleCaseWilayah(d.name) })) });
  } catch (err) {
    const code = err && err.status === 429 ? 429 : 502;
    res.status(code).json({ ok: false, error: 'Gagal memuat kecamatan. Coba ketik manual.' });
  }
});

router.get('/api/wilayah/kelurahan', async (req, res) => {
  const kec = String(req.query.kecamatan || '');
  if (!/^\d+$/.test(kec)) {
    return res.status(400).json({ ok: false, error: 'Kode kecamatan tidak valid.' });
  }
  try {
    const items = await cachedWilayah(
      'kel:' + kec, 7 * 24 * 3600 * 1000,
      () => wilayahFetch(`${WILAYAH_BASE}/villages/${encodeURIComponent(kec)}.json`)
    );
    res.json({ items: (items || []).map((d) => ({ code: String(d.id), name: titleCaseWilayah(d.name) })) });
  } catch (err) {
    const code = err && err.status === 429 ? 429 : 502;
    res.status(code).json({ ok: false, error: 'Gagal memuat kelurahan. Coba ketik manual.' });
  }
});

// Cari kecamatan + kelurahan dari nama kelurahan (autofill pin).
// ?kota=Bekasi&kelurahan=Rawasapi -> { kecamatan: {code,name}, kelurahan: {code,name} }
// Memindai daftar kecamatan kota (memakai cache) hingga ketemu.
router.get('/api/wilayah/cari', async (req, res) => {
  const kota = String(req.query.kota || '').slice(0, 100);
  const kel = normWilayahSrv(String(req.query.kelurahan || '').replace(/^(kelurahan|kel\.?|desa)\s+/i, '').slice(0, 100));
  if (!KOTA_JABODETABEK.includes(kota)) {
    return res.status(400).json({ ok: false, error: 'Kota tidak dikenal.' });
  }
  if (!kel) {
    return res.status(400).json({ ok: false, error: 'Nama kelurahan kosong.' });
  }
  try {
    const code = await resolveRegencyCode(kota);
    if (!code) return res.status(404).json({ ok: false, error: 'Kode wilayah tidak ditemukan.' });
    const districts = await cachedWilayah(
      'kec:' + code, 7 * 24 * 3600 * 1000,
      () => wilayahFetch(`${WILAYAH_BASE}/districts/${encodeURIComponent(code)}.json`)
    );
    for (const d of districts || []) {
      const dCode = String(d.id);
      const dName = titleCaseWilayah(d.name);
      let villages = [];
      try {
        villages = await cachedWilayah(
          'kel:' + dCode, 7 * 24 * 3600 * 1000,
          () => wilayahFetch(`${WILAYAH_BASE}/villages/${encodeURIComponent(dCode)}.json`)
        );
      } catch (e) { continue; }
      const hit = (villages || []).find((v) => fuzzyWilayahSrv(v.name, kel));
      if (hit) {
        return res.json({
          kecamatan: { code: dCode, name: dName },
          kelurahan: { code: String(hit.id), name: titleCaseWilayah(hit.name) },
        });
      }
    }
    res.status(404).json({ ok: false, error: 'Kelurahan tidak ditemukan di kota ini.' });
  } catch (err) {
    const code = err && err.status === 429 ? 429 : 502;
    res.status(code).json({ ok: false, error: 'Pencarian wilayah gagal. Pilih manual.' });
  }
});

router.get('/', (req, res) => {
  res.render('public/index', { title: 'Beranda - BSS' });
});

router.get('/panduan', (req, res) => {
  res.render('public/panduan', { title: 'Panduan - BSS' });
});

// ---- Struktur tim / flowchart organisasi (live dari database) ----
// KNAB → Koordinator → Head Marketing → Marketing → Penyedia Lahan.
router.get('/struktur', async (req, res) => {
  try {
    const users = await query(
      `SELECT id, name, referral_code, parent_id, is_head, is_coordinator, photo_file
       FROM users WHERE role = 'marketing' AND (is_locked = 0 OR is_locked IS NULL)
       ORDER BY id ASC`
    );
    const lands = await query(
      'SELECT marketing_id, owner_name, phone_number, unit_type, slot_no FROM lands ORDER BY id ASC'
    );
    const byParent = {};
    users.forEach((u) => {
      const p = u.parent_id ? Number(u.parent_id) : 0;
      if (!byParent[p]) byParent[p] = [];
      byParent[p].push(u);
    });
    // Urutan tampil: koordinator → head → marketing.
    Object.values(byParent).forEach((arr) => arr.sort((a, b) => (
      Number(b.is_coordinator || 0) - Number(a.is_coordinator || 0)
      || Number(b.is_head || 0) - Number(a.is_head || 0)
      || Number(a.id) - Number(b.id)
    )));
    const landsByMkt = {};
    lands.forEach((l) => {
      if (!l.marketing_id) return;
      if (!landsByMkt[l.marketing_id]) landsByMkt[l.marketing_id] = [];
      landsByMkt[l.marketing_id].push(l);
    });
    const roleOf = (u) => (Number(u.is_coordinator) === 1 ? 'KOORDINATOR'
      : (Number(u.is_head) === 1 ? 'HEAD' : 'MARKETING'));
    const initials = (n) => String(n || '?').trim().split(/\s+/)
      .map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    function ownerNodes(units) {
      const map = {};
      (units || []).forEach((l) => {
        const k = String(l.phone_number || l.owner_name);
        if (!map[k]) map[k] = { name: l.owner_name || '-', phone: l.phone_number || '', bss: 0, evcs: 0 };
        if (l.unit_type === 'evcs_mobil') map[k].evcs += 1;
        else map[k].bss += 1;
      });
      return Object.values(map);
    }
    function build(u, depth, seen) {
      if (depth > 6 || seen.has(u.id)) return null;
      seen.add(u.id);
      const units = landsByMkt[u.id] || [];
      return {
        id: u.id, name: u.name, role: roleOf(u), photo: u.photo_file || null,
        initials: initials(u.name), referral: u.referral_code || '-',
        units: units.length,
        children: (byParent[u.id] || []).map((c) => build(c, depth + 1, seen)).filter(Boolean),
        owners: ownerNodes(units),
      };
    }
    const ids = new Set(users.map((u) => Number(u.id)));
    const roots = users
      .filter((u) => !u.parent_id || !ids.has(Number(u.parent_id)))
      .map((u) => build(u, 0, new Set()))
      .filter(Boolean);
    const totalUnits = lands.length;
    const totalOwners = new Set(lands.map((l) => String(l.phone_number || l.owner_name))).size;
    res.render('public/struktur', {
      title: 'Struktur Tim - BSS', tree: roots,
      counts: { coords: users.filter((u) => Number(u.is_coordinator) === 1).length,
        heads: users.filter((u) => Number(u.is_head) === 1).length,
        marketing: users.length, units: totalUnits, owners: totalOwners },
    });
  } catch (err) {
    console.error('Struktur error:', err);
    res.status(500).render('public/404', { title: 'Terjadi Kesalahan' });
  }
});

// ---- Pendaftaran marketing mandiri (wajib kode referral marketing aktif) ----
const registerController = require('../controllers/registerController');
const registerLimiter = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('public/daftar-marketing', {
      title: 'Daftar Marketing - BSS',
      error: 'Terlalu banyak percobaan pendaftaran. Coba lagi 1 jam.',
      form: {
        name: '', email: '', whatsapp: '', nik: '', bank_name: '',
        bank_name_other: '', account_number: '',
        ref_code: String((req.body && req.body.ref_code) || ''),
      },
    });
  },
});
router.get('/daftar-marketing', registerController.showDaftar);
router.post('/daftar-marketing', registerLimiter, registerController.submitDaftar);
router.get('/verifikasi-email/:token', registerController.verifyEmail);
router.post('/daftar-marketing/kirim-ulang', registerLimiter, registerController.resendVerification);

// ---- Lupa / reset password via email (semua peran) ----
const passwordResetController = require('../controllers/passwordResetController');
const resetLimiter = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('public/lupa-password', {
      title: 'Lupa Password - BSS',
      error: 'Terlalu banyak percobaan. Coba lagi 1 jam.',
      sent: false,
    });
  },
});
router.get('/lupa-password', passwordResetController.showForgot);
router.post('/lupa-password', resetLimiter, passwordResetController.sendLink);
router.get('/reset-password/:token', passwordResetController.showReset);
router.post('/reset-password/:token', resetLimiter, passwordResetController.doReset);

function normalizePhone(input) {
  let p = String(input || '').replace(/\D/g, '');
  if (!p) return '';
  if (p.startsWith('0')) p = '62' + p.slice(1);
  else if (!p.startsWith('62')) p = '62' + p;
  return p;
}

// Validasi bank/rek/NIK/luas terpusat di utils/ownerFields.js (satu aturan utk semua peran)
const {
  resolveBankName, normNik, normRek, normArea, validateOwnerFields,
  validateLahanExtra, normHarga, normLatLong, normMapsUrl,
} = require('../utils/ownerFields');

// Lacak pengajuan milik pemilik lahan (berbasis nomor WA, tanpa login)
router.get('/lacak', async (req, res) => {
  const rawPhone = req.query.phone ? String(req.query.phone).slice(0, 20) : '';
  if (!rawPhone) {
    return res.render('public/lacak', { title: 'Lacak Pengajuan - BSS', searched: false, lands: [] });
  }
  try {
    const phone = normalizePhone(rawPhone);
    const lands = await require('../models/db').query(
      `SELECT l.id, l.owner_name, l.phone_number, l.address, l.location_address, l.area_size, l.unit_type, l.slot_no, l.location_type,
              l.status, l.survey_status, l.verify_status, l.fee_amount, l.maps_link, l.sppl_file, l.created_at,
              u.name marketing_name
       FROM lands l LEFT JOIN users u ON u.id = l.marketing_id
       WHERE l.phone_number = ? ORDER BY l.id DESC`,
      [phone]
    );
    // Slot per tipe untuk nomor ini (hasil filter sudah = semua unit pemilik):
    // BSS-1..n / EVCS-1..n + Unit ke-X dari Y.
    try {
      const { buildSlotMap } = require('../utils/slotInfo');
      const slotMap = buildSlotMap(lands.map((r) => ({ id: r.id, phone_number: r.phone_number, unit_type: r.unit_type, slot_no: r.slot_no })));
      lands.forEach((l) => { l.slot = slotMap[l.id] || null; });
    } catch (e) { lands.forEach((l) => { l.slot = null; }); }
    res.render('public/lacak', { title: 'Lacak Pengajuan - BSS', searched: true, phone: rawPhone, lands });
  } catch (err) {
    console.error('Lacak error:', err);
    res.status(500).render('public/lacak', {
      title: 'Lacak Pengajuan - BSS', searched: true, phone: rawPhone, lands: [], error: 'Gagal mencari. Coba lagi.',
    });
  }
});

router.get('/ajukan', (req, res) => {
  const referralCode = req.query.ref
    ? String(req.query.ref).slice(0, 20)
    : (req.session.referralCode || '');
  if (referralCode) req.session.referralCode = referralCode;
  res.render('public/ajukan', { title: 'Ajukan Lahan - BSS', referralCode, withMap: true });
});

// Verifikasi ID Card anggota via QR (publik, tanpa login).
// Tanpa foto: berkas /uploads/* terproteksi login, jadi hanya data teks.
router.get('/id/:referral', async (req, res) => {
  try {
    const code = String(req.params.referral || '').slice(0, 20).trim();
    if (!code) return res.status(404).render('public/404', { title: 'ID Tidak Ditemukan' });
    const member = await get(
      `SELECT id, name, whatsapp, wilayah, referral_code, is_head, created_at
       FROM users WHERE role = 'marketing' AND referral_code = ? LIMIT 1`,
      [code]
    );
    if (!member) return res.status(404).render('public/404', { title: 'ID Tidak Ditemukan' });
    const { memberId, positionLabel } = require('../utils/memberId');
    let businessName = '';
    let company = {};
    try {
      businessName = await require('../utils/settings').getSetting('business_name', '');
      company = await require('../utils/companyProfile').getCompanyProfile();
    } catch (e) { businessName = ''; company = {}; }
    res.render('public/verifikasi', {
      title: 'Verifikasi Anggota - ' + member.name,
      member,
      memberCode: memberId(member),
      position: positionLabel(member),
      brandName: (company && company.company_name) || businessName || 'BSS',
    });
  } catch (err) {
    console.error('Verifikasi ID error:', err);
    res.status(500).render('public/404', { title: 'Terjadi Kesalahan' });
  }
});

async function getFixableLand(token) {
  const t = String(token || '').slice(0, 64);
  if (!t) return null;
  const land = await get(
    `SELECT l.*, u.name marketing_name, u.referral_code FROM lands l
     LEFT JOIN users u ON u.id = l.marketing_id
     WHERE l.edit_token = ? LIMIT 1`,
    [t]
  );
  if (!land || !land.edit_expires || new Date(land.edit_expires) < new Date()) return null;
  if (land.status === 'approved') return null;
  return land;
}

// Form perbaikan data via link WA admin (token sekali pakai, kedaluwarsa otomatis)
router.get('/perbaiki/:token', async (req, res) => {
  try {
    const land = await getFixableLand(req.params.token);
    if (!land) return res.status(410).render('public/perbaiki', { title: 'Link Perbaikan - BSS', expired: true });
    res.render('public/perbaiki', { title: 'Perbaiki Pengajuan - BSS', land, expired: false, fixed: false, error: null, withMap: true });
  } catch (err) {
    console.error('Perbaiki GET error:', err);
    res.status(500).render('public/perbaiki', { title: 'Link Perbaikan - BSS', expired: true });
  }
});

router.post('/perbaiki/:token', (req, res, next) => {
  uploadFields(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Ukuran berkas melebihi 5 MB.'
        : `Upload berkas gagal: ${err.message}`;
      return getFixableLand(req.params.token).then((land) => {
        if (!land) return res.status(410).render('public/perbaiki', { title: 'Link Perbaikan - BSS', expired: true });
        res.status(400).render('public/perbaiki', { title: 'Perbaiki Pengajuan - BSS', land, expired: false, fixed: false, error: msg, withMap: true });
      }).catch(() => res.status(500).send('Terjadi kesalahan server.'));
    }
    next();
  });
}, async (req, res) => {
  try {
    const land = await getFixableLand(req.params.token);
    if (!land) return res.status(410).render('public/perbaiki', { title: 'Link Perbaikan - BSS', expired: true });
    const {
      owner_name, phone_number, address, location_address, area_size,
      unit_type, location_type, floor_ready, has_canopy, legal_doc_type, maps_link,
      ttl, surat, shop_name, city, district, harga_sewa, lat_long, maps_url,
    } = req.body;
    if (!owner_name || !phone_number || !address || !location_address || !area_size || !unit_type || !location_type || !floor_ready || !has_canopy || !legal_doc_type || !maps_link) {
      return res.status(400).render('public/perbaiki', {
        title: 'Perbaiki Pengajuan - BSS', land, expired: false, fixed: false,
        error: 'Semua kolom wajib diisi.', withMap: true,
      });
    }
    const ownerErr = validateOwnerFields(req.body);
    if (ownerErr) {
      return res.status(400).render('public/perbaiki', {
        title: 'Perbaiki Pengajuan - BSS', land, expired: false, fixed: false,
        error: ownerErr, withMap: true,
      });
    }
    // Slot manual 1-4 (fallback ke nilai lama bila tidak dikirim)
    const slotRaw = String((req.body && req.body.slot_no) || '').trim();
    const slotVal = /^[1-4]$/.test(slotRaw) ? Number(slotRaw)
      : (/^[1-4]$/.test(String(land.slot_no || '')) ? Number(land.slot_no) : null);
    if (!slotVal) {
      return res.status(400).render('public/perbaiki', {
        title: 'Perbaiki Pengajuan - BSS', land, expired: false, fixed: false,
        error: 'Pilih Slot 1–4 sesuai jenis unit.', withMap: true,
      });
    }
    const bankName = resolveBankName(req.body);
    const accountNumber = normRek(req.body.account_number);
    const nik = normNik(req.body.nik);
    const areaSize = normArea(area_size);
    // Field referensi: pertahankan nilai lama bila perbaikan tidak mengirim yg baru
    const ttlVal = String((req.body && req.body.ttl) || land.ttl || '').trim().slice(0, 100) || null;
    const suratVal = String((req.body && req.body.surat) || land.surat || '').trim().slice(0, 255) || null;
    const shopNameVal = String((req.body && req.body.shop_name) || land.shop_name || '').trim().slice(0, 150) || null;
    const cityVal = String((req.body && req.body.city) || land.city || '').trim().slice(0, 100) || null;
    const districtVal = String((req.body && req.body.district) || land.district || '').trim().slice(0, 100) || null;
    const hUnit = unit_type === 'evcs_mobil' ? 'evcs_mobil' : 'bss_motor';
    // Harga per tipe: pakai kiriman baru bila ada, pertahankan lama bila kosong.
    const hbRaw = req.body && req.body.harga_sewa_bss != null ? String(req.body.harga_sewa_bss).trim() : '';
    const heRaw = req.body && req.body.harga_sewa_evcs != null ? String(req.body.harga_sewa_evcs).trim() : '';
    const hbNew = hbRaw ? normHarga('bss_motor', hbRaw) : null;
    const heNew = heRaw ? normHarga('evcs_mobil', heRaw) : null;
    if ((hbRaw && hbNew == null) || (heRaw && heNew == null)) {
      return res.status(400).render('public/perbaiki', {
        title: 'Perbaiki Pengajuan - BSS', land, expired: false, fixed: false,
        error: 'Harga sewa harus berupa angka (atau kosongkan bila belum tahu).', withMap: true,
      });
    }
    const hargaBssVal = hbRaw ? hbNew : (land.harga_sewa_bss != null ? Number(land.harga_sewa_bss) : null);
    const hargaEvcsVal = heRaw ? heNew : (land.harga_sewa_evcs != null ? Number(land.harga_sewa_evcs) : null);
    const hargaSewaVal = hUnit === 'evcs_mobil' ? hargaEvcsVal : hargaBssVal;
    const latLongVal = normLatLong((req.body && req.body.lat_long) || land.lat_long) || null;
    const mapsUrlVal = normMapsUrl((req.body && req.body.maps_url) || land.maps_url) || null;
    let phone62 = String(phone_number).replace(/\D/g, '');
    if (phone62.startsWith('0')) phone62 = '62' + phone62.slice(1);
    else if (!phone62.startsWith('62')) phone62 = '62' + phone62;
    // Berkas: ganti bila ada upload baru, pertahankan yang lama bila tidak
    const files = req.files || {};
    // Kompresi server-side untuk berkas baru (best-effort).
    try {
      const { compressUploads } = require('../utils/imageCompress');
      await compressUploads(Object.values(files).flat().filter(Boolean), { maxDim: 1600 });
    } catch (e) {}
    const cols = ['ktp_file', 'photo_1_file', 'photo_2_file', 'photo_3_file',
      'photo_spot_file', 'photo_right_file', 'photo_left_file', 'photo_selfie_file', 'photo_maps_file',
      'legal_doc_file', 'family_doc_file', 'sewa_doc_file', 'support_doc_file'];
    const vals = {};
    cols.forEach((c) => {
      if (files[c] && files[c][0]) {
        vals[c] = `/uploads/${files[c][0].filename}`;
        if (land[c]) {
          const oldAbs = path.join(__dirname, '..', 'public', String(land[c]).replace(/^\//, ''));
          fs.unlink(oldAbs, () => {});
        }
      } else {
        vals[c] = land[c] || null;
      }
    });
    // Berkas baru wajib terisi (data lama belum punya kolom ini); pendukung tetap opsional.
    const needLabels = { photo_spot_file: 'Foto Penempatan 3/4m', photo_right_file: 'Foto Sudut Kanan', photo_left_file: 'Foto Sudut Kiri', photo_selfie_file: 'Foto Selfie Pemilik', photo_maps_file: 'Screenshot Koordinat', sewa_doc_file: 'Surat Sewa' };
    const missingNew = Object.keys(needLabels).find((c) => !vals[c]);
    if (missingNew) {
      // Hapus upload baru yang terlanjur masuk agar tak yatim
      Object.keys(files).forEach((k) => {
        (files[k] || []).forEach((f) => {
          if (f && f.filename) fs.unlink(path.join(__dirname, '..', 'public', 'uploads', f.filename), () => {});
        });
      });
      return res.status(400).render('public/perbaiki', {
        title: 'Perbaiki Pengajuan - BSS', land, expired: false, fixed: false,
        error: `Berkas "${needLabels[missingNew]}" wajib dilengkapi.`, withMap: true,
      });
    }
    // Data diperbaiki -> verifikasi harus diulang dari awal; SPPL lama dicabut
    // dan akan diterbitkan ulang otomatis saat verifikasi lolos kembali.
    if (land.sppl_file) {
      const oldSppl = path.join(__dirname, '..', 'public', String(land.sppl_file).replace(/^\//, ''));
      fs.unlink(oldSppl, () => {});
    }
    await query(
      `UPDATE lands SET owner_name = ?, phone_number = ?, bank_name = ?, account_number = ?, nik = ?, ttl = ?, surat = ?, shop_name = ?, city = ?, district = ?, harga_sewa = ?, harga_sewa_bss = ?, harga_sewa_evcs = ?, address = ?, location_address = ?, area_size = ?,
        unit_type = ?, slot_no = ?, location_type = ?, floor_ready = ?, has_canopy = ?, legal_doc_type = ?, maps_link = ?, lat_long = ?, maps_url = ?,
        ktp_file = ?, photo_1_file = ?, photo_2_file = ?, photo_3_file = ?, photo_spot_file = ?, photo_right_file = ?, photo_left_file = ?, photo_selfie_file = ?, photo_maps_file = ?, legal_doc_file = ?, family_doc_file = ?, sewa_doc_file = ?, support_doc_file = ?,
        status = 'pending', verify_status = 'belum', survey_status = 'belum', sppl_file = NULL, edit_token = NULL, edit_expires = NULL
       WHERE id = ? AND edit_token = ?`,
      [
        String(owner_name).trim(), phone62, bankName, accountNumber, nik, ttlVal, suratVal, shopNameVal, cityVal, districtVal, hargaSewaVal, hargaBssVal, hargaEvcsVal, String(address).trim(), String(location_address).trim(), areaSize,
        unit_type === 'evcs_mobil' ? 'evcs_mobil' : 'bss_motor', slotVal, String(location_type || '').trim(),
        floor_ready === 'ya' ? 'ya' : 'tidak', has_canopy === 'ya' ? 'ya' : 'tidak',
        unit_type === 'evcs_mobil' ? 'shm' : 'pbb', String(maps_link || '').trim(), latLongVal, mapsUrlVal,
        vals.ktp_file, vals.photo_1_file, vals.photo_2_file, vals.photo_3_file,
        vals.photo_spot_file, vals.photo_right_file, vals.photo_left_file, vals.photo_selfie_file, vals.photo_maps_file,
        vals.legal_doc_file, vals.family_doc_file, vals.sewa_doc_file, vals.support_doc_file,
        land.id, String(req.params.token).slice(0, 64),
      ]
    );
    // Kembali pending = persetujuan gugur -> fee yang pernah tercatat ikut batal (anti fee yatim)
    await query('DELETE FROM fee_logs WHERE land_id = ?', [land.id]);
    try {
      const { notify } = require('../utils/notify');
      notify({
        audience: 'admins',
        userIds: land.marketing_id ? [land.marketing_id] : [],
        title: `✏️ Perbaikan lahan #${land.id} dikirim`,
        body: `Data diperbaiki pemilik, kembali pending — perlu verifikasi ulang.`,
        link: '/admin/lands',
      }).catch(() => {});
    } catch (e) {}
    res.render('public/perbaiki', { title: 'Perbaikan Terkirim - BSS', land: null, expired: false, fixed: true, error: null });
  } catch (err) {
    console.error('Perbaiki POST error:', err);
    res.status(500).render('public/perbaiki', { title: 'Link Perbaikan - BSS', expired: true });
  }
});

router.post('/submit-lahan', (req, res, next) => {
  uploadFields(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Ukuran berkas melebihi 5 MB.'
        : `Upload berkas gagal: ${err.message}`;
      return res.status(400).render('public/ajukan', {
        title: 'Ajukan Lahan - BSS',
        referralCode: (req.body && req.body.referral_code) || '',
        error: msg,
        withMap: true,
      });
    }
    next();
  });
}, async (req, res) => {
  // Inti pengajuan dipakai bersama API mobile — lihat utils/submitLahan.js.
  const referral_code = (req.body && req.body.referral_code) || req.session.referralCode || '';
  try {
    const { submitLahan } = require('../utils/submitLahan');
    const r = await submitLahan({ body: req.body, files: req.files, sessionReferralCode: req.session.referralCode });
    res.render('public/sukses', { title: 'Pengajuan Terkirim - BSS', referralCode: r.referralCode });
  } catch (err) {
    console.error('Submit lahan error:', err);
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'Ukuran berkas melebihi 5 MB.'
      : err.message && err.message.includes('dependencies')
        ? 'Semua kolom wajib diisi.'
        : err.message || 'terjadi kesalahan server.';
    res.status(err.status || 500).render('public/ajukan', {
      title: 'Ajukan Lahan - BSS',
      referralCode: referral_code || '',
      error: msg,
      withMap: true,
    });
  }
});

module.exports = router;