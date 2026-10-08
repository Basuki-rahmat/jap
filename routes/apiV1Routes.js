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
} = require('../utils/apiAuth');

const router = express.Router();

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

module.exports = router;
