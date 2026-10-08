// REST API JSON untuk aplikasi mobile (React Native) — versi 1.
// Auth via header Authorization: Bearer <access_jwt>. Semua respons JSON:
// sukses { ok: true, ... } / gagal { ok: false, message }.
const express = require('express');
const bcrypt = require('bcryptjs');
const { query, get } = require('../models/db');
const {
  ACCESS_TTL_SEC,
  signAccess,
  storeRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  purgeExpired,
  publicUser,
  isApiAuth,
  isApiRole,
} = require('../utils/apiAuth');
const { callWeb, flashResult } = require('../utils/callWeb');
const marketingController = require('../controllers/marketingController');
const adminController = require('../controllers/adminController');

const router = express.Router();

// Hasil controller web -> respons JSON API.
function sendWeb(res, r) {
  if (!r) return res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
  if (r.type === 'redirect') {
    const f = flashResult(r);
    return res.status(f.ok ? 200 : 400).json(f);
  }
  if (r.type === 'render' || r.type === 'json') {
    return res.status(r.status && r.status >= 400 ? r.status : 200).json({
      ok: !(r.status && r.status >= 400),
      ...(r.type === 'render' ? { view: r.view, data: r.data } : r.data),
    });
  }
  const code = r.status || 200;
  return res.status(code).json({ ok: code < 400, message: r.message || '' });
}

function webHandler(fn, pick) {
  return async (req, res) => {
    try {
      const r = await callWeb(fn, {
        apiUser: publicUser(req.apiUser),
        body: req.body,
        files: req.files,
        query: req.query,
        params: req.params,
        req,
      });
      if (pick && r && r.type === 'render') {
        return res.json({ ok: true, data: pick(r.data) });
      }
      sendWeb(res, r);
    } catch (err) {
      console.error('API webHandler error:', err && err.message);
      res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
    }
  };
}

// Pesan status akun disamakan dengan login web (authController).
function accountMessage(user) {
  if (user.role === 'marketing' && user.mkt_status === 'pending_verification') {
    return 'Email Anda belum diverifikasi. Cek inbox (termasuk spam) lalu klik link verifikasi.';
  }
  if (user.role === 'marketing' && user.mkt_status === 'pending_approval') {
    return 'Pendaftaran Anda menunggu persetujuan admin (biasanya 1x24 jam kerja).';
  }
  return 'Akun dikunci oleh admin (kebijakan perusahaan). Hubungi admin.';
}

// POST /api/v1/auth/login { email, password, device_name? }
router.post('/auth/login', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 100);
    const password = String((req.body && req.body.password) || '');
    const deviceName = String((req.body && req.body.device_name) || '').slice(0, 100);
    if (!email || !password) {
      return res.status(400).json({ ok: false, message: 'Email dan password wajib diisi.' });
    }
    const user = await get('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ ok: false, message: 'Email atau password salah.' });
    }
    if (Number(user.is_locked) === 1) {
      return res.status(403).json({ ok: false, message: accountMessage(user) });
    }
    purgeExpired().catch(() => {});
    const accessToken = signAccess(user);
    const refreshToken = await storeRefreshToken(user.id, deviceName);
    res.json({
      ok: true,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TTL_SEC,
      user: publicUser(user),
    });
  } catch (err) {
    console.error('API login error:', err && err.message);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
  }
});

// POST /api/v1/auth/refresh { refresh_token } -> pasangan baru (rotasi).
router.post('/auth/refresh', async (req, res) => {
  try {
    const token = String((req.body && req.body.refresh_token) || '');
    if (!token) return res.status(400).json({ ok: false, message: 'refresh_token wajib diisi.' });
    const rotated = await rotateRefreshToken(token);
    if (!rotated) {
      return res.status(401).json({ ok: false, message: 'Sesi kedaluwarsa. Silakan login ulang.' });
    }
    purgeExpired().catch(() => {});
    const accessToken = signAccess(rotated.user);
    const refreshToken = await storeRefreshToken(rotated.user.id, rotated.deviceName);
    res.json({
      ok: true,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TTL_SEC,
      user: publicUser(rotated.user),
    });
  } catch (err) {
    console.error('API refresh error:', err && err.message);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
  }
});

// POST /api/v1/auth/logout — butuh Bearer; { refresh_token? } bila diisi hanya
// sesi itu yang dicabut, bila kosong semua sesi user dicabut.
router.post('/auth/logout', isApiAuth, async (req, res) => {
  try {
    const token = String((req.body && req.body.refresh_token) || '');
    if (token) await revokeRefreshToken(token);
    else await revokeAllForUser(req.apiUser.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('API logout error:', err && err.message);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
  }
});

// GET /api/v1/me — profil ringkas pemilik token.
router.get('/me', isApiAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.apiUser) });
});

// GET /api/v1/notifications?limit= — inbox milik sendiri (maks 100).
router.get('/notifications', isApiAuth, async (req, res) => {
  try {
    let limit = Number(req.query.limit) || 30;
    if (!Number.isFinite(limit) || limit < 1) limit = 30;
    limit = Math.min(limit, 100);
    const items = await query(
      `SELECT id, title, body, link, is_read, created_at FROM notifications
       WHERE target_user_id = ? ORDER BY id DESC LIMIT ${limit}`,
      [Number(req.apiUser.id)]
    );
    const unread = await get(
      'SELECT COUNT(*) total FROM notifications WHERE target_user_id = ? AND is_read = 0',
      [Number(req.apiUser.id)]
    );
    res.json({ ok: true, unread: Number(unread ? unread.total : 0), items });
  } catch (err) {
    console.error('API notifications error:', err && err.message);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
  }
});

// POST /api/v1/notifications/read { id | all: true }
router.post('/notifications/read', isApiAuth, async (req, res) => {
  try {
    const me = Number(req.apiUser.id);
    if (req.body && (req.body.all === true || req.body.all === 1 || req.body.all === '1')) {
      await query('UPDATE notifications SET is_read = 1 WHERE target_user_id = ?', [me]);
    } else {
      const id = Number(req.body && req.body.id);
      if (!id) return res.status(400).json({ ok: false, message: 'id / all wajib diisi.' });
      await query('UPDATE notifications SET is_read = 1 WHERE id = ? AND target_user_id = ?', [id, me]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('API notif read error:', err && err.message);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
  }
});

// POST /api/v1/device-token { token, platform: android|ios } — daftar untuk push FCM.
router.post('/device-token', isApiAuth, async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || '').trim().slice(0, 255);
    const platform = String((req.body && req.body.platform) || 'android').toLowerCase() === 'ios' ? 'ios' : 'android';
    if (!token) return res.status(400).json({ ok: false, message: 'token perangkat wajib diisi.' });
    await query(
      `INSERT INTO device_tokens (user_id, platform, token) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE platform = VALUES(platform), updated_at = CURRENT_TIMESTAMP`,
      [Number(req.apiUser.id), platform, token]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('API device-token error:', err && err.message);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
  }
});

// ============ MARKETING (role marketing) ============
const isMarketing = [isApiAuth, isApiRole('marketing')];

// Ringkasan dasbor: status lahan, fee, daftar lahan + referral link.
router.get('/marketing/dashboard', ...isMarketing,
  webHandler(marketingController.dashboard, (d) => ({
    me: d.me,
    status_counts: d.statusCounts,
    fee: { total: d.totalFee, paid: d.paidFee, unpaid: d.unpaidFee },
    lands: d.lands,
    net_lands: d.netLands,
    is_head: d.isHead,
    is_coordinator: d.isCoordinator,
    parent: d.parent,
    downlines: d.downlines,
    referral_code: d.referralCode,
    referral_link: d.referralLink,
    rekrut_link: d.rekrutLink,
  })));

// Pohon jaringan downline + statistik lahan.
router.get('/marketing/jaringan', ...isMarketing,
  webHandler(marketingController.network, (d) => ({
    me: d.me,
    tree: d.tree,
    direct_count: d.directCount,
    total_count: d.totalCount,
    max_level: d.maxLevel,
    land_stats: d.landStats,
    net_lands: d.netLands,
    net_approved: d.netApproved,
  })));

// Data ID card digital (termasuk QR verifyUrl sebagai data-URL).
router.get('/marketing/id-card', ...isMarketing,
  webHandler(marketingController.idCard, (d) => ({
    member: d.member,
    member_code: d.memberCode,
    position: d.position,
    brand_name: d.brandName,
    brand_logo: d.brandLogo,
    verify_url: d.verifyUrl,
    qr_data_url: d.qrDataUrl,
  })));

router.get('/marketing/surat-tugas', ...isMarketing,
  webHandler(marketingController.suratTugas, (d) => ({
    member: d.member,
    member_code: d.memberCode,
    position: d.position,
    company_name: d.companyName,
    brand_logo: d.brandLogo,
    signer_name: d.signerName,
    signer_title: d.signerTitle,
    signature_file: d.signatureFile,
    place: d.place,
    nomor: d.nomor,
    verify_url: d.verifyUrl,
    qr_data_url: d.qrDataUrl,
  })));

// Upload profil mandiri: foto diri + KTP (gambar, maks 5 MB/berkas — sama spt. web).
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const profilDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(profilDir)) fs.mkdirSync(profilDir, { recursive: true });
const uploadProfilApi = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, profilDir),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, `mkt-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Foto harus JPG/PNG/WebP.'));
  },
}).fields([
  { name: 'photo_file', maxCount: 1 },
  { name: 'ktp_file', maxCount: 1 },
]);

router.patch('/marketing/profil', ...isMarketing, (req, res, next) => {
  uploadProfilApi(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        ok: false,
        message: err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran foto melebihi 5 MB.' : `Upload gagal: ${err.message}`,
      });
    }
    next();
  });
}, webHandler(marketingController.updateProfile));

router.post('/marketing/password', ...isMarketing, webHandler(marketingController.updatePassword));

// ============ LAHAN (publik spt. web; referral via body) ============
const uploadLahanApi = require('../config/upload');

router.post('/lahan', (req, res, next) => {
  uploadLahanApi(req, res, (err) => {
    if (err) {
      // Berkas yang terlanjur tersimpan dibersihkan agar tak yatim.
      if (req.files) {
        Object.values(req.files).flat().filter(Boolean).forEach((f) => {
          try { fs.unlink(path.join(profilDir, f.filename), () => {}); } catch (e) {}
        });
      }
      return res.status(400).json({
        ok: false,
        message: err.code === 'LIMIT_FILE_SIZE'
          ? 'Ukuran berkas melebihi 5 MB.'
          : `Upload berkas gagal: ${err.message}`,
      });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { submitLahan, SubmitError } = require('../utils/submitLahan');
    const r = await submitLahan({ body: req.body, files: req.files, sessionReferralCode: null });
    res.status(201).json({ ok: true, land_ids: r.landIds, referral_code: r.referralCode, unit_list: r.unitList });
  } catch (err) {
    console.error('API submit lahan error:', err && err.message);
    res.status(err.status || 500).json({ ok: false, message: err.message || 'Terjadi kesalahan server.' });
  }
});

// Lacak pengajuan milik pemilik (berbasis no. WA, tanpa login — sama spt. /lacak).
router.get('/lahan', async (req, res) => {
  try {
    const rawPhone = String(req.query.phone || '').slice(0, 20);
    if (!rawPhone) return res.status(400).json({ ok: false, message: 'Parameter phone wajib diisi.' });
    const { normalizePhone62 } = require('../utils/submitLahan');
    const phone = normalizePhone62(rawPhone);
    const lands = await query(
      `SELECT l.id, l.owner_name, l.phone_number, l.address, l.location_address, l.area_size, l.unit_type, l.slot_no, l.location_type,
              l.status, l.survey_status, l.verify_status, l.fee_amount, l.maps_link, l.sppl_file, l.created_at,
              u.name marketing_name
       FROM lands l LEFT JOIN users u ON u.id = l.marketing_id
       WHERE l.phone_number = ? ORDER BY l.id DESC`,
      [phone]
    );
    try {
      const { buildSlotMap } = require('../utils/slotInfo');
      const slotMap = buildSlotMap(lands.map((r) => ({ id: r.id, phone_number: r.phone_number, unit_type: r.unit_type, slot_no: r.slot_no })));
      lands.forEach((l) => { l.slot = slotMap[l.id] || null; });
    } catch (e) { lands.forEach((l) => { l.slot = null; }); }
    res.json({ ok: true, phone: rawPhone, lands });
  } catch (err) {
    console.error('API lacak error:', err && err.message);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
  }
});

// ============ ADMIN (role superadmin) ============
const isAdmin = [isApiAuth, isApiRole('superadmin')];

// Daftar marketing + agregat (mobile memfilter pending_approval sendiri).
router.get('/admin/marketing', ...isAdmin,
  webHandler(adminController.marketing, (d) => ({
    marketers: d.marketers,
    heads: d.heads,
    coords: d.coords,
  })));

// Daftar lahan (?status=pending|approved|rejected).
router.get('/admin/lahan', ...isAdmin,
  webHandler(adminController.lands, (d) => ({
    lands: d.lands,
    status_filter: d.statusFilter,
    owner_slots: d.ownerSeq,
  })));

router.post('/admin/pendaftar/approve', ...isAdmin, webHandler(adminController.approveMarketing));
router.post('/admin/pendaftar/reject', ...isAdmin, webHandler(adminController.rejectMarketing));
router.post('/admin/lahan/approve', ...isAdmin, webHandler(adminController.approveLand));
router.post('/admin/lahan/reject', ...isAdmin, webHandler(adminController.rejectLand));
router.post('/admin/lahan/stage', ...isAdmin, webHandler(adminController.stageFlag));
router.post('/admin/lahan/request-fix', ...isAdmin, webHandler(adminController.requestFix));
router.post('/admin/lahan/harga', ...isAdmin, webHandler(adminController.updateHarga));
router.post('/admin/lahan/sppl', ...isAdmin, webHandler(adminController.regenerateSppl));
router.post('/admin/marketing/lock', ...isAdmin, webHandler(adminController.toggleLock));

module.exports = router;
