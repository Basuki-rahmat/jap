// Token unduh SPPL publik (halaman /lacak, tanpa login).
//
// Pemilik lahan tidak punya akun, tapi SPPL-nya harus tetap bisa diunduh
// dari halaman lacak (yang hanya dijaga nomor WA). Agar folder uploads tetap
// tertutup, link unduh TIDAK memakai path /uploads/* melainkan URL
// bertanda-tangan: /sppl-unduh/<id>?sig=<hmac>
// HMAC dihitung dari id lahan + nomor WA tersimpan dengan secret server,
// sehingga URL tidak bisa ditebak/enumerasi dan tidak berlaku untuk lahan
// lain bila nomor WA berbeda.
const crypto = require('crypto');

function secret() {
  return process.env.API_JWT_SECRET || process.env.SESSION_SECRET || 'jap-secret-dev-only';
}

function signSppl(landId, phone) {
  return crypto
    .createHmac('sha256', secret())
    .update(String(Number(landId)) + '|' + String(phone || ''))
    .digest('hex');
}

function verifySppl(landId, phone, sig) {
  const s = String(sig || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) return false;
  const expect = signSppl(landId, phone);
  try {
    return crypto.timingSafeEqual(Buffer.from(s, 'hex'), Buffer.from(expect, 'hex'));
  } catch (e) {
    return false;
  }
}

module.exports = { signSppl, verifySppl };
