// Server berkas privat — pengganti akses langsung /uploads/*.
//
// Mengapa file ini ada:
// - Folder `public/uploads` berisi KTP/foto lahan/dokumen sensitif.
// - URL `/uploads/<file>` TIDAK boleh muncul di HTML/JSON/Network dan tidak
//   boleh bisa ditebak/di-share/di-index (lihat utils/fileUrl.js).
// - Satu-satunya cara membuka berkas adalah lewat route ini:
//     GET /berkas/<nama-file>[?token=<access_jwt>]
//   dengan syarat WAJIB login (sesi web atau Bearer JWT mobile) + lolos cek
//   kepemilikan di bawah. Jawaban gagal selalu 404 agar keberadaan berkas
//   tidak bisa diintip (tidak ada 401/403 yang membocorkan).
//
// Header respons diset agar berkas tidak tersimpan di cache/disk:
//   Cache-Control: private, no-store + X-Robots-Tag: noindex.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { query: dbQuery } = require('../models/db');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');

// Kolom berkas lahan (harus sama dengan yang dipakai saat upload).
const FILE_COLS = ['ktp_file', 'photo_1_file', 'photo_2_file', 'photo_3_file', 'photo_spot_file', 'photo_right_file', 'photo_left_file', 'photo_selfie_file', 'photo_maps_file', 'legal_doc_file', 'family_doc_file', 'sewa_doc_file', 'support_doc_file', 'sppl_file'];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png|webp|pdf)$/i;

function noStore(res) {
  res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.set('X-Content-Type-Options', 'nosniff');
}

function notFound(res) {
  noStore(res);
  return res.status(404).send('Tidak ditemukan.');
}

async function resolveUser(req) {
  if (req.session && req.session.user) return req.session.user;
  try {
    const q = String((req.query && req.query.token) || '').replace(/^Bearer\s+/i, '');
    const h = String(req.get('authorization') || req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { verifyAccess } = require('../utils/apiAuth');
    const payload = verifyAccess(q || h);
    if (!payload) return null;
    const rows = await dbQuery(
      'SELECT id, role, is_head, is_locked FROM users WHERE id = ? LIMIT 1',
      [Number(payload.uid)]
    );
    if (!rows.length || Number(rows[0].is_locked) === 1) return null;
    return { id: Number(rows[0].id), role: rows[0].role, is_head: Number(rows[0].is_head || 0) };
  } catch (e) {
    return null;
  }
}

router.get('/:name', async (req, res) => {
  try {
    const name = String(req.params.name || '');
    if (!NAME_RE.test(name)) return notFound(res);

    const user = await resolveUser(req);
    if (!user) return notFound(res); // sengaja 404, bukan 401

    const legacy = '/uploads/' + name;

    // Superadmin: boleh semua.
    if (user.role !== 'superadmin') {
      let allowed = false;

      // 1) Berkas lahan milik sendiri.
      try {
        const cond = FILE_COLS.map((c) => `${c} = ?`).join(' OR ');
        const rows = await dbQuery(
          `SELECT id FROM lands WHERE marketing_id = ? AND (${cond}) LIMIT 1`,
          [user.id, ...FILE_COLS.map(() => legacy)]
        );
        if (rows.length) allowed = true;
      } catch (e) {}

      // 2) Head marketing: berkas jaringan downline-nya (semua level).
      if (!allowed && user.role === 'marketing') {
        try {
          const headRow = await dbQuery('SELECT is_head FROM users WHERE id = ? LIMIT 1', [user.id]);
          if (headRow.length && Number(headRow[0].is_head) === 1) {
            const allMkt = await dbQuery(`SELECT id, parent_id FROM users WHERE role = 'marketing'`);
            const byParent = {};
            allMkt.forEach((u) => {
              const p = u.parent_id ? Number(u.parent_id) : 0;
              if (!byParent[p]) byParent[p] = [];
              byParent[p].push(Number(u.id));
            });
            const allowedIds = new Set([Number(user.id)]);
            const stack = (byParent[user.id] || []).slice();
            let guard = 0;
            while (stack.length && guard < 5000) {
              guard += 1;
              const did = stack.pop();
              if (allowedIds.has(Number(did))) continue;
              allowedIds.add(Number(did));
              (byParent[did] || []).forEach((k) => stack.push(k));
            }
            const ids = Array.from(allowedIds).filter((v) => v !== Number(user.id));
            if (ids.length) {
              const cond = FILE_COLS.map((c) => `${c} = ?`).join(' OR ');
              const ph = ids.map(() => '?').join(',');
              const netRows = await dbQuery(
                `SELECT id FROM lands WHERE marketing_id IN (${ph}) AND (${cond}) LIMIT 1`,
                [...ids, ...FILE_COLS.map(() => legacy)]
              );
              if (netRows.length) allowed = true;
            }
          }
        } catch (e) {}
      }

      // 3) Foto diri sendiri (avatar). KTP orang lain tetap dilarang —
      //    avatar milik sendiri + avatar marketing lain boleh dilihat user
      //    login mana pun (daftar member, ID card) tapi TIDAK publik.
      if (!allowed) {
        try {
          const own = await dbQuery(
            'SELECT id FROM users WHERE id = ? AND photo_file = ? LIMIT 1',
            [user.id, legacy]
          );
          if (own.length) allowed = true;
          else {
            const avatar = await dbQuery('SELECT id FROM users WHERE photo_file = ? LIMIT 1', [legacy]);
            if (avatar.length) allowed = true;
          }
        } catch (e) {}
      }

      if (!allowed) return notFound(res); // sengaja 404, bukan 403
    }

    const abs = path.join(UPLOAD_DIR, name);
    // Cegah traversal: hasil join harus tetap di dalam UPLOAD_DIR.
    if (path.dirname(abs) !== UPLOAD_DIR) return notFound(res);
    fs.stat(abs, (err, st) => {
      if (err || !st || !st.isFile()) return notFound(res);
      noStore(res);
      return res.sendFile(abs);
    });
  } catch (err) {
    return notFound(res);
  }
});

module.exports = router;
