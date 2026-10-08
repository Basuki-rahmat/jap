// Notifikasi dalam-aplikasi dua arah (admin <-> marketing/head).
// Satu baris per penerima (fan-out saat kirim) agar status dibaca per orang.
// Audiens: 'admins' | 'all_marketing' | 'heads', atau userIds eksplisit.
// Akun terkunci (is_locked) dilewati — tak bisa login, tak perlu notif.
const { query } = require('../models/db');

async function userIdsFor(audience) {
  let sql = null;
  if (audience === 'admins') {
    sql = "SELECT id FROM users WHERE role = 'superadmin' AND (is_locked = 0 OR is_locked IS NULL)";
  } else if (audience === 'all_marketing') {
    sql = "SELECT id FROM users WHERE role = 'marketing' AND (is_locked = 0 OR is_locked IS NULL)";
  } else if (audience === 'heads') {
    sql = "SELECT id FROM users WHERE role = 'marketing' AND is_head = 1 AND (is_locked = 0 OR is_locked IS NULL)";
  } else {
    return [];
  }
  const rows = await query(sql);
  return rows.map((r) => Number(r.id));
}

async function notify({ senderId = null, audience = null, userIds = [], title, body = '', link = null }) {
  const t = String(title || '').trim().slice(0, 150);
  if (!t) return 0;
  let ids = (Array.isArray(userIds) ? userIds : [userIds]).map(Number).filter((v) => Number.isInteger(v) && v > 0);
  if (audience) {
    const resolved = await userIdsFor(audience);
    ids = ids.concat(resolved);
  }
  ids = [...new Set(ids)];
  if (!ids.length) return 0;
  const b = String(body || '').slice(0, 2000);
  const l = link ? String(link).slice(0, 500) : null;
  const placeholders = ids.map(() => '(?, ?, ?, ?, ?)').join(',');
  const params = [];
  ids.forEach((id) => params.push(senderId, id, t, b, l));
  await query(
    `INSERT INTO notifications (sender_id, target_user_id, title, body, link) VALUES ${placeholders}`,
    params
  );
  return ids.length;
}

module.exports = { notify, userIdsFor };
