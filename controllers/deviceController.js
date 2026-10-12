// Perangkat dikenal per user (pendamping peringatan email login baru).
// Satu akun bisa dipakai di banyak role (superadmin/admin/marketing),
// jadi route dipasang global di /perangkat (isAuth saja) seperti /notifikasi.
const crypto = require('crypto');
const { query } = require('../models/db');

function myId(req) {
  const id = Number(req.session.user && req.session.user.id);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function backFor(req) {
  const role = req.session.user && req.session.user.role;
  return role === 'superadmin' || role === 'admin' ? '/admin' : '/marketing';
}

// Hash sama persis dengan utils/loginAlert agar baris "perangkat ini" akurat.
// Web: device_name kosong (login form tak mengirimnya).
function currentHash(req) {
  const ua = String((req && typeof req.get === 'function' && req.get('user-agent')) || '');
  const key = `|${ua.toLowerCase().trim()}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function tableExists() {
  try {
    await query('SELECT id FROM user_devices LIMIT 1');
    return true;
  } catch (err) {
    return !(err && err.code === 'ER_NO_SUCH_TABLE');
  }
}

exports.showDevices = async (req, res) => {
  try {
    let devices = [];
    let missing = false;
    try {
      devices = await query(
        `SELECT id, device_name, user_agent, last_ip, first_seen, last_seen
         FROM user_devices WHERE user_id = ? ORDER BY last_seen DESC LIMIT 50`,
        [myId(req)]
      );
    } catch (err) {
      if (err && err.code === 'ER_NO_SUCH_TABLE') {
        missing = true;
        devices = [];
      } else {
        throw err;
      }
    }
    const cur = currentHash(req);
    let currentId = null;
    try {
      const rows = await query(
        'SELECT id FROM user_devices WHERE user_id = ? AND device_hash = ? LIMIT 1',
        [myId(req), cur]
      );
      if (rows.length) currentId = rows[0].id;
    } catch (e) {}
    res.render('devices/list', {
      title: 'Perangkat Dikenal',
      devices,
      currentId,
      missingTable: missing,
      back: backFor(req),
    });
  } catch (err) {
    console.error('Device list error:', err && err.message);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.forgetDevice = async (req, res) => {
  const back = backFor(req);
  try {
    const id = Number(req.body && req.body.id);
    if (!id) {
      req.session.flash = { type: 'error', message: 'Perangkat tidak valid.' };
      return res.redirect('/perangkat');
    }
    await query('DELETE FROM user_devices WHERE id = ? AND user_id = ?', [id, myId(req)]);
    req.session.flash = {
      type: 'success',
      message: 'Perangkat dilupakan. Login berikutnya dari perangkat itu akan memicu email peringatan lagi.',
    };
    return res.redirect('/perangkat');
  } catch (err) {
    console.error('Device forget error:', err && err.message);
    req.session.flash = { type: 'error', message: 'Gagal menghapus perangkat.' };
    return res.redirect('/perangkat');
  }
};

exports.forgetOthers = async (req, res) => {
  try {
    const cur = currentHash(req);
    await query('DELETE FROM user_devices WHERE user_id = ? AND device_hash <> ?', [myId(req), cur]);
    req.session.flash = { type: 'success', message: 'Semua perangkat lain dilupakan.' };
    return res.redirect('/perangkat');
  } catch (err) {
    console.error('Device forget-others error:', err && err.message);
    req.session.flash = { type: 'error', message: 'Gagal menghapus perangkat lain.' };
    return res.redirect('/perangkat');
  }
};
