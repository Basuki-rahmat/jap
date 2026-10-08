// Auth token untuk aplikasi mobile (React Native) — berdampingan dengan
// session cookie web. Access = JWT pendek (15 mnt), refresh = token acak
// yang hash-nya disimpan di tabel api_tokens (rotasi tiap dipakai).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { query, get } = require('../models/db');

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_DAYS = 7;

function jwtSecret() {
  return process.env.API_JWT_SECRET || process.env.SESSION_SECRET || 'jap-secret-dev-only';
}

function signAccess(user) {
  return jwt.sign(
    { uid: Number(user.id), role: user.role },
    jwtSecret(),
    { expiresIn: ACCESS_TTL_SEC }
  );
}

function newRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function refreshExpiresAt() {
  const d = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);
  // Format MySQL DATETIME (UTC): YYYY-MM-DD HH:MM:SS
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Simpan refresh token (hash saja) untuk user. Kembalikan token plaintext
// (hanya terlihat sekali saat login/refresh) + tanggal kedaluwarsa.
async function storeRefreshToken(userId, deviceName) {
  const token = newRefreshToken();
  await query(
    `INSERT INTO api_tokens (user_id, token_hash, device_name, expires_at)
     VALUES (?, ?, ?, ?)`,
    [Number(userId), hashToken(token), String(deviceName || '').slice(0, 100) || null, refreshExpiresAt()]
  );
  // Batasi maksimal 10 sesi per user (hapus yang paling lama).
  await query(
    `DELETE FROM api_tokens WHERE user_id = ? AND id NOT IN
     (SELECT id FROM (SELECT id FROM api_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 10) t)`,
    [Number(userId), Number(userId)]
  );
  return token;
}

// Tukar refresh token dengan pasangan baru (rotasi: token lama hangus).
// Return { user } bila valid, null bila tidak.
async function rotateRefreshToken(token) {
  const row = await get('SELECT * FROM api_tokens WHERE token_hash = ? LIMIT 1', [hashToken(token)]);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    await query('DELETE FROM api_tokens WHERE id = ?', [row.id]);
    return null;
  }
  const user = await get('SELECT * FROM users WHERE id = ? LIMIT 1', [row.user_id]);
  await query('DELETE FROM api_tokens WHERE id = ?', [row.id]);
  if (!user || Number(user.is_locked) === 1) return null;
  return { user, deviceName: row.device_name };
}

async function revokeRefreshToken(token) {
  await query('DELETE FROM api_tokens WHERE token_hash = ?', [hashToken(token)]);
}

async function revokeAllForUser(userId) {
  await query('DELETE FROM api_tokens WHERE user_id = ?', [Number(userId)]);
}

// Hapus token kedaluwarsa (dipanggil best-effort saat login/refresh).
async function purgeExpired() {
  try {
    await query('DELETE FROM api_tokens WHERE expires_at < NOW()');
  } catch (e) {}
}

// Bentuk publik user untuk respons API (tanpa password/hash).
function publicUser(u) {
  return {
    id: Number(u.id),
    name: u.name,
    email: u.email,
    role: u.role,
    referral_code: u.referral_code || null,
    parent_id: u.parent_id != null ? Number(u.parent_id) : null,
    is_head: Number(u.is_head || 0),
    is_coordinator: Number(u.is_coordinator || 0),
    mkt_status: u.mkt_status || null,
    photo_file: u.photo_file || null,
  };
}

// Middleware: wajib header Authorization: Bearer <access_jwt>.
// Menolak akun terkunci seperti isAuth web. Error selalu JSON.
async function isApiAuth(req, res, next) {
  try {
    const h = String(req.get('authorization') || req.get('Authorization') || '');
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ ok: false, message: 'Token akses wajib diisi.' });
    let payload;
    try {
      payload = jwt.verify(m[1].trim(), jwtSecret());
    } catch (e) {
      return res.status(401).json({ ok: false, message: 'Token tidak valid / kedaluwarsa.' });
    }
    const user = await get('SELECT * FROM users WHERE id = ? LIMIT 1', [Number(payload.uid)]);
    if (!user) return res.status(401).json({ ok: false, message: 'Akun tidak ditemukan.' });
    if (Number(user.is_locked) === 1) {
      return res.status(403).json({ ok: false, message: 'Akun dikunci oleh admin. Hubungi admin.' });
    }
    req.apiUser = user;
    return next();
  } catch (err) {
    console.error('isApiAuth error:', err && err.message);
    return res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
  }
}

function isApiRole(...roles) {
  return (req, res, next) => {
    if (!req.apiUser) return res.status(401).json({ ok: false, message: 'Login dahulu.' });
    if (!roles.includes(req.apiUser.role)) {
      return res.status(403).json({ ok: false, message: 'Akses ditolak untuk peran ini.' });
    }
    return next();
  };
}

module.exports = {
  ACCESS_TTL_SEC,
  REFRESH_TTL_DAYS,
  signAccess,
  storeRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  purgeExpired,
  publicUser,
  isApiAuth,
  isApiRole,
};
