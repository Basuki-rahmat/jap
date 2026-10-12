// Peringatan login perangkat baru per user via email.
// Dipakai dari login web (controllers/authController) & login API mobile
// (routes/apiV1Routes). Cara kerja:
//  - fingerprint = SHA256(device_name|user-agent yang dinormalisasi).
//  - bila (user_id, device_hash) belum ada di user_devices -> perangkat baru.
//  - login pertama kali user (belum punya baris sama sekali) TIDAK dikirim
//    email agar tidak spam saat akun baru dibuat.
//  - pengiriman via mailer.sendMailAsync (fire-and-forget) agar login tak tertahan.
//  - bila tabel belum ada (lupa upgradeDb), dilewati dengan log, login tetap jalan.
const crypto = require('crypto');
const { query, get } = require('../models/db');

function fingerprint(req, deviceName = '') {
  const ua = String((req && typeof req.get === 'function' && req.get('user-agent')) || '').slice(0, 500);
  const key = `${String(deviceName || '').toLowerCase().trim()}|${ua.toLowerCase().trim()}`;
  return {
    hash: crypto.createHash('sha256').update(key).digest('hex'),
    ua,
  };
}

function clientIp(req) {
  // Di belakang proxy (trust proxy = 1), req.ip sudah IP asli client.
  const ip = String((req && (req.ip || (req.connection && req.connection.remoteAddress))) || '');
  return ip.slice(0, 45) || null;
}

// Return true bila perangkat baru + email peringatan coba dikirim.
// TIDAK pernah throw — kegagalan selalu ditelan agar login tetap sukses.
async function checkNewDeviceAndAlert(req, user, deviceName = '') {
  try {
    if (!user || !user.id || !user.email) return false;
    const { hash, ua } = fingerprint(req, deviceName);
    const ip = clientIp(req);
    const devName = String(deviceName || '').slice(0, 100) || null;

    let known = null;
    try {
      known = await get(
        'SELECT id FROM user_devices WHERE user_id = ? AND device_hash = ? LIMIT 1',
        [Number(user.id), hash]
      );
    } catch (err) {
      if (err && err.code === 'ER_NO_SUCH_TABLE') {
        console.error('[loginAlert] Tabel user_devices belum ada — jalankan "node config/upgradeDb.js".');
        return false;
      }
      throw err;
    }

    if (known) {
      try {
        await query('UPDATE user_devices SET last_ip = ? WHERE id = ?', [ip, known.id]);
      } catch (e) {}
      return false;
    }

    let isFirstEver = false;
    try {
      const cnt = await get('SELECT COUNT(*) c FROM user_devices WHERE user_id = ?', [Number(user.id)]);
      isFirstEver = !cnt || Number(cnt.c) === 0;
      await query(
        `INSERT INTO user_devices (user_id, device_hash, device_name, user_agent, last_ip)
         VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE last_ip = VALUES(last_ip)`,
        [Number(user.id), hash, devName, ua || null, ip]
      );
    } catch (err) {
      if (err && err.code === 'ER_NO_SUCH_TABLE') {
        console.error('[loginAlert] Tabel user_devices belum ada — jalankan "node config/upgradeDb.js".');
        return false;
      }
      throw err;
    }

    if (isFirstEver) return false;

    try {
      const { emailBrand, renderEmail, sendMailAsync } = require('./mailer');
      const brand = await emailBrand();
      const loginAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
      const html = await renderEmail('new-device.ejs', {
        ...brand,
        userName: user.name || user.email,
        userEmail: user.email,
        deviceName: devName || (ua ? ua.slice(0, 80) : 'Perangkat tidak dikenal'),
        loginAt,
        ip: ip || '-',
        userAgent: ua || '-',
      });
      sendMailAsync({
        to: user.email,
        subject: `Login baru terdeteksi — akun ${brand.brandName}`,
        html,
        text: `Halo ${user.name || user.email}, ada login baru ke akun Anda pada ${loginAt} dari IP ${ip || '-'}. Bukan Anda? Segera ganti password dan hubungi admin.`,
      });
    } catch (e) {
      console.error('[loginAlert] Gagal menyiapkan email perangkat baru:', e && e.message);
    }
    return true;
  } catch (err) {
    console.error('[loginAlert] error:', err && err.message);
    return false;
  }
}

module.exports = { checkNewDeviceAndAlert };
