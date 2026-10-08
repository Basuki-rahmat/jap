const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { query, get } = require('../models/db');
const {
  resolveBankName, normNik, normRek, validateMarketingIdentity, normalizePhone62,
} = require('../utils/ownerFields');

function flash(req, type, message) {
  req.session.flash = { type, message };
}

// Defense-in-depth anti-SQLi: ID sesi harus integer positif.
// Semua query di file ini memakai placeholder (?); ID tak valid = sesi rusak -> login ulang.
function sessionUserId(req) {
  const id = Number(req.session.user && req.session.user.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function countByStatus(rows) {
  const map = { pending: 0, approved: 0, rejected: 0 };
  rows.forEach((r) => {
    map[r.status] = r.total;
  });
  return map;
}

exports.dashboard = async (req, res) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) return res.redirect('/login');

    const me = await get(
      'SELECT id, name, email, referral_code, downline_quota, parent_id, is_head, is_coordinator FROM users WHERE id = ?',
      [userId]
    );

    const statusCounts = countByStatus(
      await query('SELECT status, COUNT(*) total FROM lands WHERE marketing_id = ? GROUP BY status', [userId])
    );

    // Akumulasi fee dari total approve (hak marketing sebenarnya, sudah
    // memperhitungkan aturan persen/rupiah) + rincian lunas/belum untuk menu pembayaran.
    const feeRows = await query(
      `SELECT COALESCE(SUM(amount),0) acc,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END),0) paid,
              COALESCE(SUM(CASE WHEN status = 'unpaid' THEN amount ELSE 0 END),0) unpaid
       FROM fee_logs WHERE marketing_id = ?`,
      [userId]
    );
    const totalFee = feeRows[0].acc;
    const paidFee = feeRows[0].paid;
    const unpaidFee = feeRows[0].unpaid;

    const lands = await query(
      `SELECT id, marketing_id, owner_name, phone_number, address, location_address,
              area_size, unit_type, location_type, floor_ready, has_canopy, legal_doc_type,
              maps_link, ktp_file, photo_1_file, photo_2_file, photo_3_file,
              legal_doc_file, family_doc_file, sppl_file, status, survey_status,
              verify_status, fee_amount, created_at, edit_token, edit_expires
       FROM lands WHERE marketing_id = ? ORDER BY id DESC`,
      [userId]
    );

    // Slot multi-titik global per pemilik (konsisten dengan admin):
    // BSS-1..n / EVCS-1..n + Unit ke-X dari Y.
    try {
      const { buildSlotMap } = require('../utils/slotInfo');
      const allSlots = await query('SELECT id, phone_number, unit_type, slot_no FROM lands ORDER BY id ASC');
      const slotMap = buildSlotMap(allSlots);
      lands.forEach((l) => { l.slot = slotMap[l.id] || null; });
    } catch (e) { lands.forEach((l) => { l.slot = null; }); }

    // Head: daftar pengajuan jaringan (semua level downline) agar bisa
    // meminta perbaikan ke penyedia di referral sendiri maupun tim bawahnya.
    // Sengaja TANPA proposal/approve/reject — head hanya boleh minta perbaikan.
    let netLands = [];
    const isHead = me && (Number(me.is_head) === 1 || Number(me.is_coordinator) === 1);
    const isCoordinator = me && Number(me.is_coordinator) === 1;
    if (isHead) {
      try {
        const allMkt = await query(`SELECT id, parent_id FROM users WHERE role = 'marketing' ORDER BY id ASC`);
        const byParent = {};
        allMkt.forEach((u) => {
          const p = u.parent_id ? Number(u.parent_id) : 0;
          if (!byParent[p]) byParent[p] = [];
          byParent[p].push(Number(u.id));
        });
        const desc = [];
        const seenNet = new Set([Number(userId)]);
        const stackNet = (byParent[userId] || []).slice();
        let guard = 0;
        while (stackNet.length && guard < 5000) {
          guard += 1;
          const did = stackNet.pop();
          if (seenNet.has(Number(did))) continue;
          seenNet.add(Number(did));
          desc.push(Number(did));
          (byParent[did] || []).forEach((k) => stackNet.push(k));
        }
        if (desc.length) {
          const ph = desc.map(() => '?').join(',');
          netLands = await query(
            `SELECT l.id, l.marketing_id, l.owner_name, l.phone_number, l.address, l.location_address,
                    l.area_size, l.unit_type, l.location_type,
                    l.status, l.survey_status, l.verify_status, l.fee_amount, l.sppl_file,
                    l.created_at, l.edit_token, l.edit_expires, u.name AS marketer_name
             FROM lands l LEFT JOIN users u ON u.id = l.marketing_id
             WHERE l.marketing_id IN (${ph}) ORDER BY l.id DESC LIMIT 200`,
            desc
          );
          try {
            const { buildSlotMap: bsm } = require('../utils/slotInfo');
            const allSlots2 = await query('SELECT id, phone_number, unit_type, slot_no FROM lands ORDER BY id ASC');
            const slotMap2 = bsm(allSlots2);
            netLands.forEach((l) => { l.slot = slotMap2[l.id] || null; });
          } catch (e) { netLands.forEach((l) => { l.slot = null; }); }
        }
      } catch (e) { netLands = []; }
    }

    const parent = me.parent_id
      ? await get('SELECT name FROM users WHERE id = ?', [me.parent_id])
      : null;

    const downlines = await query('SELECT id, name, email, referral_code, created_at FROM users WHERE parent_id = ? ORDER BY id DESC', [userId]);

    const referralCode = me.referral_code || '';
    const baseUrl = String(res.locals.APP_URL || process.env.APP_URL || 'http://localhost:3000').trim().replace(/\/+$/, '');
    const referralLink = baseUrl + '/ajukan?ref=' + encodeURIComponent(referralCode);
    const rekrutLink = baseUrl + '/daftar-marketing?ref=' + encodeURIComponent(referralCode);

    res.render('marketing/dashboard', {
      title: 'Dashboard Marketing - JAP',
      me,
      statusCounts,
      totalFee,
      paidFee,
      unpaidFee,
      lands,
      netLands,
      isHead,
      isCoordinator,
      parent,
      downlines,
      referralCode,
      referralLink,
      rekrutLink,
    });
  } catch (err) {
    console.error('Marketing dashboard error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.network = async (req, res) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) return res.redirect('/login');

    const me = await get(
      'SELECT id, name, email, referral_code, downline_quota FROM users WHERE id = ?',
      [userId]
    );
    if (!me) return res.status(404).send('Akun tidak ditemukan.');

    // Ambil semua marketing sekali, susun pohon di JS (skala kecil)
    const all = await query(
      `SELECT id, name, email, referral_code, parent_id, created_at FROM users WHERE role = 'marketing' ORDER BY id ASC`
    );
    const byParent = {};
    all.forEach((u) => {
      const p = u.parent_id ? Number(u.parent_id) : 0;
      if (!byParent[p]) byParent[p] = [];
      byParent[p].push(u);
    });

    // Telusuri keturunan (BFS) dengan level
    const tree = [];
    let queue = (byParent[userId] || []).map((u) => ({ user: u, level: 1 }));
    const seen = new Set([userId]);
    let guard = 0;
    while (queue.length && guard < 5000) {
      guard += 1;
      const node = queue.shift();
      if (seen.has(Number(node.user.id))) continue;
      seen.add(Number(node.user.id));
      tree.push(node);
      const kids = byParent[node.user.id] || [];
      kids.forEach((k) => queue.push({ user: k, level: node.level + 1 }));
    }

    const directCount = (byParent[userId] || []).length;
    const totalCount = tree.length;
    const maxLevel = tree.reduce((m, n) => Math.max(m, n.level), 0);

    // Statistik lahan per anggota jaringan dalam 1 query
    const ids = tree.map((n) => n.user.id);
    let landStats = {};
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = await query(
        `SELECT marketing_id,
                COUNT(*) total,
                SUM(status = 'approved') approved,
                SUM(status = 'pending') pending
         FROM lands WHERE marketing_id IN (${placeholders}) GROUP BY marketing_id`,
        ids
      );
      rows.forEach((r) => { landStats[r.marketing_id] = r; });
    }
    const netLands = Object.values(landStats).reduce((s, r) => s + Number(r.total || 0), 0);
    const netApproved = Object.values(landStats).reduce((s, r) => s + Number(r.approved || 0), 0);

    res.render('marketing/jaringan', {
      title: 'Jaringan Saya - JAP',
      me,
      tree,
      directCount,
      totalCount,
      maxLevel,
      landStats,
      netLands,
      netApproved,
    });
  } catch (err) {
    console.error('Marketing network error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.showPassword = async (req, res) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) return res.redirect('/login');
    const me = await get('SELECT id, name FROM users WHERE id = ?', [userId]);
    if (!me) return res.redirect('/login');
    res.render('marketing/password', { title: 'Ganti Password - JAP', me });
  } catch (err) {
    console.error('Marketing password page error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.updatePassword = async (req, res) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) return res.redirect('/login');
    const oldPass = String(req.body.old_password || '');
    const newPass = String(req.body.new_password || '');
    const confirmPass = String(req.body.confirm_password || '');

    if (!oldPass || !newPass || !confirmPass) {
      flash(req, 'error', 'Semua kolom wajib diisi.');
      return res.redirect('/marketing/password');
    }
    if (newPass.length < 6) {
      flash(req, 'error', 'Password baru minimal 6 karakter.');
      return res.redirect('/marketing/password');
    }
    if (newPass !== confirmPass) {
      flash(req, 'error', 'Konfirmasi password tidak sama.');
      return res.redirect('/marketing/password');
    }

    const user = await get('SELECT password FROM users WHERE id = ?', [userId]);
    if (!user || !(await bcrypt.compare(oldPass, user.password))) {
      flash(req, 'error', 'Password lama salah.');
      return res.redirect('/marketing/password');
    }

    await query('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(newPass, 10), userId]);
    flash(req, 'success', 'Password berhasil diganti.');
    res.redirect('/marketing/password');
  } catch (err) {
    console.error('Marketing password update error:', err);
    flash(req, 'error', 'Gagal mengganti password.');
    res.redirect('/marketing/password');
  }
};

async function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = 'JAP';
    for (let i = 0; i < 6; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    const exist = await get('SELECT id FROM users WHERE referral_code = ?', [code]);
    if (!exist) return code;
  }
  throw new Error('Gagal membuat kode referral unik.');
}

async function requireHead(req) {
  // Jabatan Head Marketing & Koordinator: tanpa batas kuota (kuota hanya berlaku untuk marketing biasa).
  // Koordinator = atasan para head (hak setara head + bisa mengangkat downline jadi head).
  const userId = sessionUserId(req);
  if (!userId) return { ok: false, redirect: true };
  const head = await get('SELECT id, name, is_head, is_coordinator FROM users WHERE id = ? AND role = ? AND (is_head = 1 OR is_coordinator = 1)', [userId, 'marketing']);
  if (!head) return { ok: false, message: 'Hanya Head Marketing / Koordinator yang bisa menambah downline.' };
  return { ok: true, head, isCoordinator: Number(head.is_coordinator) === 1 };
}

exports.showTambah = async (req, res) => {
  try {
    const chk = await requireHead(req);
    if (chk.redirect) return res.redirect('/login');
    if (!chk.ok) {
      flash(req, 'error', chk.message);
      return res.redirect('/marketing');
    }
    res.render('marketing/tambah', { title: 'Tambah Downline - JAP', isCoordinator: !!chk.isCoordinator });
  } catch (err) {
    console.error('Marketing tambah page error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

// Head menambah downline langsung: parent = head, TANPA potong kuota
exports.createDownline = async (req, res) => {
  try {
    const chk = await requireHead(req);
    if (chk.redirect) return res.redirect('/login');
    if (!chk.ok) {
      flash(req, 'error', chk.message);
      return res.redirect('/marketing');
    }
    const userId = chk.head.id;

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const whatsapp = normalizePhone62(req.body.whatsapp);
    if (!name || !email) {
      flash(req, 'error', 'Nama dan email wajib diisi.');
      return res.redirect('/marketing/tambah');
    }
    if (!whatsapp) {
      flash(req, 'error', 'No. WhatsApp wajib diisi.');
      return res.redirect('/marketing/tambah');
    }
    const identErr = validateMarketingIdentity(req.body);
    if (identErr) {
      flash(req, 'error', identErr);
      return res.redirect('/marketing/tambah');
    }
    const bankName = resolveBankName(req.body);
    const accountNumber = normRek(req.body.account_number);
    const nik = normNik(req.body.nik);

    const dupEmail = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (dupEmail) {
      flash(req, 'error', `Email ${email} sudah terdaftar.`);
      return res.redirect('/marketing/tambah');
    }
    const dupWa = await get('SELECT id FROM users WHERE whatsapp = ?', [whatsapp]);
    if (dupWa) {
      flash(req, 'error', 'No. WhatsApp sudah dipakai akun lain (tidak bisa double).');
      return res.redirect('/marketing/tambah');
    }
    const dupNik = await get('SELECT id FROM users WHERE nik = ?', [nik]);
    if (dupNik) {
      flash(req, 'error', 'NIK / No. KTP sudah terdaftar (tidak bisa double).');
      return res.redirect('/marketing/tambah');
    }

    const customPass = String(req.body.password || '');
    if (customPass && customPass.length < 6) {
      flash(req, 'error', 'Password minimal 6 karakter.');
      return res.redirect('/marketing/tambah');
    }
    const plainPass = customPass || 'jap12345';
    const hash = await bcrypt.hash(plainPass, 10);
    const referralCode = await generateReferralCode();
    // Koordinator boleh mengangkat downline langsung jadi Head (centang opsi).
    const makeHead = chk.isCoordinator && String(req.body.make_head || '') === '1' ? 1 : 0;

    await query(
      'INSERT INTO users (name, email, whatsapp, nik, bank_name, account_number, fee_type, fee_value, password, role, referral_code, parent_id, is_head, downline_quota) VALUES (?,?,?,?,?,?,NULL,0,?,?,?,?,?,0)',
      [name, email, whatsapp, nik, bankName, accountNumber, hash, 'marketing', referralCode, userId, makeHead]
    );

    flash(req, 'success', `Downline "${name}" ditambahkan (kode: ${referralCode}, password: ${plainPass})${makeHead ? ' sebagai HEAD MARKETING' : ''}.`);
    res.redirect('/marketing');
  } catch (err) {
    console.error('Create downline error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      flash(req, 'error', 'Gagal: Email / No. WA / NIK sudah dipakai akun lain (tidak bisa double).');
    } else {
      flash(req, 'error', 'Gagal menambah downline.');
    }
    res.redirect('/marketing/tambah');
  }
};

// Head meminta perbaikan ke penyedia pada referral sendiri maupun jaringan
// downline-nya (semua level). Sengaja TIDAK ada proposal/approve/reject di sini.
exports.requestFix = async (req, res) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) return res.redirect('/login');
    const me = await get('SELECT id, name, is_head, is_coordinator FROM users WHERE id = ? AND role = ?', [userId, 'marketing']);
    if (!me || (Number(me.is_head) !== 1 && Number(me.is_coordinator) !== 1)) {
      flash(req, 'error', 'Hanya Head Marketing / Koordinator yang bisa meminta perbaikan.');
      return res.redirect('/marketing');
    }
    const landId = Number(req.body.land_id);
    if (!landId) {
      flash(req, 'error', 'Pengajuan tidak valid.');
      return res.redirect('/marketing');
    }
    const land = await get('SELECT id, marketing_id, status FROM lands WHERE id = ?', [landId]);
    if (!land) {
      flash(req, 'error', 'Pengajuan tidak ditemukan.');
      return res.redirect('/marketing');
    }
    if (land.status === 'approved') {
      flash(req, 'error', 'Pengajuan sudah disetujui — tidak bisa diminta perbaikan.');
      return res.redirect('/marketing');
    }
    // Cakupan: milik sendiri + milik seluruh downline (semua level).
    const allMkt = await query(`SELECT id, parent_id FROM users WHERE role = 'marketing' ORDER BY id ASC`);
    const byParent = {};
    allMkt.forEach((u) => {
      const p = u.parent_id ? Number(u.parent_id) : 0;
      if (!byParent[p]) byParent[p] = [];
      byParent[p].push(Number(u.id));
    });
    const allowed = new Set([Number(userId)]);
    const stack = (byParent[userId] || []).slice();
    let guard = 0;
    while (stack.length && guard < 5000) {
      guard += 1;
      const did = stack.pop();
      if (allowed.has(Number(did))) continue;
      allowed.add(Number(did));
      (byParent[did] || []).forEach((k) => stack.push(k));
    }
    if (!allowed.has(Number(land.marketing_id))) {
      flash(req, 'error', 'Anda hanya bisa meminta perbaikan untuk referral sendiri atau jaringan downline Anda.');
      return res.redirect('/marketing');
    }
    const token = require('crypto').randomBytes(32).toString('hex');
    await query('UPDATE lands SET edit_token = ?, edit_expires = DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE id = ?', [token, landId]);
    flash(req, 'success', `Link perbaikan lahan #${landId} dibuat (berlaku 7 hari). Klik "Salin Link" lalu kirim via WA ke pemilik.`);
    res.redirect('/marketing');
  } catch (err) {
    console.error('Marketing request fix error:', err);
    flash(req, 'error', 'Gagal membuat link perbaikan.');
    res.redirect('/marketing');
  }
};

function removeUploads(files) {
  try {
    Object.keys(files || {}).forEach((k) => {
      (files[k] || []).forEach((f) => {
        if (f && f.filename) fs.unlink(path.join(__dirname, '..', 'public', 'uploads', f.filename), () => {});
      });
    });
  } catch (e) {}
}

exports.showProfile = async (req, res) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) return res.redirect('/login');
    const me = await get(
      `SELECT id, name, email, whatsapp, nik, bank_name, account_number, wilayah,
              photo_file, ktp_file, referral_code, downline_quota, parent_id,
is_head, is_coordinator
       FROM users WHERE id = ?`,
      [userId]
    );
    if (!me) return res.redirect('/login');
    res.render('marketing/profil', { title: 'Profil Saya - JAP', me });
  } catch (err) {
    console.error('Marketing profile page error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

// Profil mandiri: WA + NIK + bank + rek (anti-double) + upload foto diri & KTP
exports.updateProfile = async (req, res) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) return res.redirect('/login');
    const me = await get('SELECT id, photo_file, ktp_file FROM users WHERE id = ?', [userId]);
    if (!me) return res.redirect('/login');

    const fail = (msg) => {
      removeUploads(req.files); // berkas yang terlanjur upload dibuang agar tak yatim
      flash(req, 'error', msg);
      return res.redirect('/marketing/profil');
    };

    const whatsapp = normalizePhone62(req.body.whatsapp);
    if (!whatsapp) return fail('No. WhatsApp wajib diisi.');
    const identErr = validateMarketingIdentity(req.body);
    if (identErr) return fail(identErr);
    const bankName = resolveBankName(req.body);
    const accountNumber = normRek(req.body.account_number);
    const nik = normNik(req.body.nik);
    const wilayah = String(req.body.wilayah || '').trim().slice(0, 100) || null;

    const dupWa = await get('SELECT id FROM users WHERE whatsapp = ? AND id != ?', [whatsapp, userId]);
    if (dupWa) return fail('No. WhatsApp sudah dipakai akun lain (tidak bisa double).');
    const dupNik = await get('SELECT id FROM users WHERE nik = ? AND id != ?', [nik, userId]);
    if (dupNik) return fail('NIK / No. KTP sudah terdaftar (tidak bisa double).');

    const files = req.files || {};
    const swapFile = (oldPath, up) => {
      if (up && up[0]) {
        const np = '/uploads/' + up[0].filename;
        if (oldPath) {
          fs.unlink(path.join(__dirname, '..', 'public', String(oldPath).replace(/^\//, '')), () => {});
        }
        return np;
      }
      return oldPath;
    };
    const photoFile = swapFile(me.photo_file, files.photo_file);
    const ktpFile = swapFile(me.ktp_file, files.ktp_file);

    await query(
      'UPDATE users SET whatsapp = ?, nik = ?, bank_name = ?, account_number = ?, wilayah = ?, photo_file = ?, ktp_file = ? WHERE id = ?',
      [whatsapp, nik, bankName, accountNumber, wilayah, photoFile, ktpFile, userId]
    );
    // Kompresi server-side untuk foto baru (best-effort, tak menggagalkan simpan).
    try {
      const { compressUploads } = require('../utils/imageCompress');
      const fresh = [];
      if (files.photo_file && files.photo_file[0]) fresh.push(files.photo_file[0]);
      if (files.ktp_file && files.ktp_file[0]) fresh.push(files.ktp_file[0]);
      if (fresh.length) await compressUploads(fresh, { maxDim: 1280 });
    } catch (e) {}
    flash(req, 'success', 'Profil berhasil diperbarui.');
    res.redirect('/marketing/profil');
  } catch (err) {
    console.error('Marketing profile update error:', err);
    removeUploads(req.files);
    if (err.code === 'ER_DUP_ENTRY') {
      flash(req, 'error', 'Gagal: No. WA / NIK sudah dipakai akun lain (tidak bisa double).');
    } else {
      flash(req, 'error', 'Gagal memperbarui profil.');
    }
    res.redirect('/marketing/profil');
  }
};

// ID Card digital anggota (marketing & head marketing — label posisi mengikuti is_head).
// Cetak 54mm x 85,6mm via tombol print di halaman.
exports.idCard = async (req, res) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) return res.redirect('/login');
    const me = await get(
      `SELECT id, name, whatsapp, wilayah, photo_file, referral_code, is_head, is_coordinator, created_at
       FROM users WHERE id = ? AND role = 'marketing'`,
      [userId]
    );
    if (!me) return res.redirect('/login');
    const { memberId, positionLabel } = require('../utils/memberId');
    const { getCompanyProfile } = require('../utils/companyProfile');
    let businessName = '';
    let company = {};
    try {
      businessName = await require('../utils/settings').getSetting('business_name', '');
      company = await getCompanyProfile();
    } catch (e) { businessName = ''; company = {}; }
    const host = req.get('host') || process.env.APP_HOST || 'localhost:3000';
    const envUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
    const base = envUrl && !/localhost/.test(envUrl) ? envUrl : req.protocol + '://' + host;
    const verifyUrl = me.referral_code ? base + '/id/' + encodeURIComponent(me.referral_code) : base + '/';
    let qrDataUrl = null;
    try {
      qrDataUrl = await require('qrcode').toDataURL(verifyUrl, { width: 220, margin: 1 });
    } catch (e) {
      console.error('QR ID card error:', e.message);
      qrDataUrl = null;
    }
    res.render('marketing/id-card', {
      title: 'ID Card - ' + me.name,
      member: me,
      memberCode: memberId(me),
      position: positionLabel(me),
      brandName: (company && company.company_name) || businessName || 'BSS',
      brandLogo: (company && company.company_logo) || '/img/logo.png',
      verifyUrl,
      qrDataUrl,
    });
  } catch (err) {
    console.error('Marketing ID card error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

// Surat Tugas Digital petugas lapangan (marketing & head marketing).
// Nomor: ST-YYYYMMDD-XXXX/JPN-BSS-XXXXXX/MM/YYYY (XXXX = 4 digit akhir WA).
exports.suratTugas = async (req, res) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) return res.redirect('/login');
    const me = await get(
      `SELECT id, name, whatsapp, wilayah, photo_file, referral_code, is_head, is_coordinator, created_at
       FROM users WHERE id = ? AND role = 'marketing'`,
      [userId]
    );
    if (!me) return res.redirect('/login');
    const { memberId, positionLabel } = require('../utils/memberId');
    const { getCompanyProfile } = require('../utils/companyProfile');
    let businessName = '';
    let company = {};
    try {
      businessName = await require('../utils/settings').getSetting('business_name', '');
      company = await getCompanyProfile();
    } catch (e) { businessName = ''; company = {}; }
    const digits = String(me.whatsapp || '').replace(/\D/g, '');
    const now = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const nomor = 'ST-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
      + '-' + (digits.length >= 4 ? digits.slice(-4) : String(me.id).padStart(4, '0'))
      + '/' + memberId(me)
      + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear();
    const host = req.get('host') || process.env.APP_HOST || 'localhost:3000';
    const envUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
    const base = envUrl && !/localhost/.test(envUrl) ? envUrl : req.protocol + '://' + host;
    const verifyUrl = me.referral_code ? base + '/id/' + encodeURIComponent(me.referral_code) : base + '/';
    let qrDataUrl = null;
    try {
      qrDataUrl = await require('qrcode').toDataURL(verifyUrl, { width: 220, margin: 1 });
    } catch (e) {
      console.error('QR surat tugas error:', e.message);
      qrDataUrl = null;
    }
    res.render('marketing/surat-tugas', {
      title: 'Surat Tugas - ' + me.name,
      member: me,
      memberCode: memberId(me),
      position: positionLabel(me),
      companyName: (company && company.company_name) || businessName || 'BSS',
      brandLogo: (company && company.company_logo) || '/img/logo.png',
      signerName: (company && company.signer_name) || '',
      signerTitle: (company && company.signer_title) || '',
      signatureFile: (company && company.signature_file) || null,
      place: (company && company.company_city) || '',
      nomor,
      verifyUrl,
      qrDataUrl,
    });
  } catch (err) {
    console.error('Marketing surat tugas error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};
