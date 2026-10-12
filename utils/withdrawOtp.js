// OTP penarikan dana: kode 6 digit dikirim ke email mitra, kedaluwarsa 10 menit.
// Kode disimpan sebagai hash SHA256 (bukan plain) + terikat nominal pengajuan.
// Tabel dibuat otomatis (IF NOT EXISTS) agar jalan di hosting tanpa SSH.
const crypto = require('crypto');
const { query } = require('../models/db');

const OTP_TTL_MINUTES = 10;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

async function ensureOtpSchema() {
  await query(
    `CREATE TABLE IF NOT EXISTS withdrawal_otps (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      otp_hash CHAR(64) NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      expires_at DATETIME NOT NULL,
      used TINYINT(1) NOT NULL DEFAULT 0,
      attempts INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_user (user_id, used, expires_at)
    ) ENGINE=InnoDB`
  );
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');
}

// Buat OTP baru untuk (user, nominal). OTP lama yang belum dipakai digugurkan.
// Return { ok, code } atau { ok:false, error, retryAfter } bila terlalu sering.
async function requestOtp(userId, amount) {
  await ensureOtpSchema();
  const recent = await query(
    'SELECT id, created_at FROM withdrawal_otps WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  );
  if (recent.length && recent[0].created_at) {
    const ageSec = Math.floor((Date.now() - new Date(recent[0].created_at).getTime()) / 1000);
    if (ageSec < OTP_RESEND_SECONDS) {
      return { ok: false, error: 'Kode baru saja dikirim. Tunggu sebentar sebelum minta lagi.', retryAfter: OTP_RESEND_SECONDS - ageSec };
    }
  }
  await query('UPDATE withdrawal_otps SET used = 1 WHERE user_id = ? AND used = 0', [userId]);
  const code = String(crypto.randomInt(100000, 1000000));
  await query(
    'INSERT INTO withdrawal_otps (user_id, otp_hash, amount, expires_at) VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL ? MINUTE))',
    [userId, hashCode(code), amount, OTP_TTL_MINUTES]
  );
  return { ok: true, code, ttlMinutes: OTP_TTL_MINUTES };
}

// Verifikasi OTP milik user untuk nominal yang sama. Sekali pakai.
async function verifyOtp(userId, code, amount) {
  await ensureOtpSchema();
  const c = String(code == null ? '' : code).replace(/\D/g, '').slice(0, 6);
  if (c.length !== 6) return { ok: false, error: 'Masukkan 6 digit kode OTP dari email.' };
  const rows = await query(
    'SELECT id, otp_hash, amount, attempts FROM withdrawal_otps WHERE user_id = ? AND used = 0 AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
    [userId]
  );
  if (!rows.length) {
    return { ok: false, error: 'Kode OTP tidak ditemukan atau sudah kedaluwarsa. Minta kode baru.' };
  }
  const row = rows[0];
  if (Number(row.amount) !== Number(amount)) {
    return { ok: false, error: 'Nominal berubah setelah kode dikirim. Minta kode baru.' };
  }
  if (Number(row.attempts) >= OTP_MAX_ATTEMPTS) {
    await query('UPDATE withdrawal_otps SET used = 1 WHERE id = ?', [row.id]);
    return { ok: false, error: 'Terlalu banyak salah. Minta kode baru.' };
  }
  const a = Buffer.from(row.otp_hash, 'hex');
  const b = Buffer.from(hashCode(c), 'hex');
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    await query('UPDATE withdrawal_otps SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    const left = OTP_MAX_ATTEMPTS - (Number(row.attempts) + 1);
    return { ok: false, error: left > 0 ? `Kode OTP salah. Sisa ${left} percobaan.` : 'Kode OTP salah. Minta kode baru.' };
  }
  await query('UPDATE withdrawal_otps SET used = 1 WHERE id = ?', [row.id]);
  return { ok: true };
}

module.exports = { ensureOtpSchema, requestOtp, verifyOtp, OTP_TTL_MINUTES, OTP_RESEND_SECONDS };
