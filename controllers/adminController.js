const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { query, get } = require('../models/db');
const {
  resolveBankName, normNik, normRek, validateMarketingIdentity, normalizePhone62,
} = require('../utils/ownerFields');

const DEFAULT_PASSWORD = 'jap12345';

function countByStatus(rows) {
  const map = { pending: 0, approved: 0, rejected: 0 };
  rows.forEach((r) => {
    map[r.status] = r.total;
  });
  return map;
}

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

function flash(req, type, message) {
  req.session.flash = { type, message };
}

// Kembali ke daftar lahan TANPA me-reset filter (?status=...).
// Pakai Referer yang divalidasi (path persis /admin/lands) agar aman dari open-redirect.
function backToLands(req, res) {
  try {
    const ref = String(req.get('Referer') || req.get('referer') || '');
    const u = new URL(ref, 'http://internal');
    if (u.pathname === '/admin/lands') return res.redirect(u.pathname + u.search);
  } catch (e) {}
  return res.redirect('/admin/lands');
}

exports.dashboard = async (req, res) => {
  try {
    const totalMarketing = (await query('SELECT COUNT(*) total FROM users WHERE role = ?', ['marketing']))[0].total;
    const statusCounts = countByStatus(await query('SELECT status, COUNT(*) total FROM lands GROUP BY status'));
    const totalApproved = (await query('SELECT COALESCE(SUM(fee_amount),0) total FROM lands WHERE status = ?', ['approved']))[0].total;
    const totalDownlines = (await query('SELECT COUNT(*) total FROM users WHERE parent_id IS NOT NULL'))[0].total;
    const totalLahan = (statusCounts.pending || 0) + (statusCounts.approved || 0) + (statusCounts.rejected || 0);
    const sisaKuota = (await query('SELECT COALESCE(SUM(downline_quota),0) s FROM users WHERE role = ?', ['marketing']))[0].s;
    // --- Data BI: tren bulanan, top marketing, delta vs periode sebelumnya ---
    const months = req.query.months === '12' ? 12 : 6;
    const monthNames = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    const now = new Date();
    const keys = [];
    for (let i = months - 1; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const lbl = months === 12
        ? `${monthNames[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`
        : monthNames[d.getMonth()];
      keys.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: lbl });
    }
    const since = `${keys[0].key}-01`;
    const monthlyRaw = await query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') m, status, COUNT(*) c, COALESCE(SUM(fee_amount),0) f
       FROM lands WHERE created_at >= ? GROUP BY m, status`,
      [since]
    );
    const trendLahan = { approved: [], pending: [], rejected: [] };
    const trendFee = [];
    keys.forEach((k) => {
      ['approved', 'pending', 'rejected'].forEach((s) => {
        const row = monthlyRaw.find((r) => r.m === k.key && r.status === s);
        trendLahan[s].push(row ? Number(row.c) : 0);
      });
      const fee = monthlyRaw.filter((r) => r.m === k.key && r.status === 'approved')
        .reduce((sum, r) => sum + Number(r.f), 0);
      trendFee.push(fee);
    });
    // Delta vs N bulan sebelumnya
    const prevRows = await query(
      `SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN status = 'approved' THEN fee_amount ELSE 0 END),0) f
       FROM lands WHERE created_at >= DATE_SUB(?, INTERVAL ? MONTH) AND created_at < ?`,
      [since, months, since]
    );
    const curC = trendLahan.approved.reduce((a, b) => a + b, 0)
      + trendLahan.pending.reduce((a, b) => a + b, 0)
      + trendLahan.rejected.reduce((a, b) => a + b, 0);
    const curF = trendFee.reduce((a, b) => a + b, 0);
    const prevC = Number(prevRows[0].c);
    const prevF = Number(prevRows[0].f);
    const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0));
    // Top 5 marketing berdasarkan fee approved
    const topMarketing = await query(
      `SELECT u.name, COUNT(l.id) total,
              SUM(CASE WHEN l.status = 'approved' THEN 1 ELSE 0 END) approved,
              COALESCE(SUM(CASE WHEN l.status = 'approved' THEN l.fee_amount ELSE 0 END),0) fee
       FROM users u LEFT JOIN lands l ON l.marketing_id = u.id
       WHERE u.role = 'marketing' GROUP BY u.id, u.name
       ORDER BY fee DESC LIMIT 5`
    );
    const recentLands = await query(
      `SELECT l.*, u.name marketing_name FROM lands l
       LEFT JOIN users u ON u.id = l.marketing_id
       ORDER BY l.id DESC LIMIT 8`
    );
    // Titik peta sebaran Jabodetabek: semua status (pin maker 3 varian).
    // Parse koordinat dari maps_link (?q=lat,lng).
    let mapPoints = [];
    try {
      const pointRows = await query(
          `SELECT l.id, l.owner_name, l.address, l.location_address, l.unit_type, l.status, l.maps_link, u.name marketing_name
           FROM lands l LEFT JOIN users u ON u.id = l.marketing_id
           WHERE l.maps_link IS NOT NULL AND l.maps_link <> ''
           ORDER BY l.id DESC LIMIT 500`
      );
      pointRows.forEach((r) => {
        const m = String(r.maps_link || '').match(/q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
        if (!m) return;
        const lat = Number(m[1]), lng = Number(m[2]);
        if (!isFinite(lat) || !isFinite(lng)) return;
        if (lat < -7.2 || lat > -5.7 || lng < 105.9 || lng > 107.6) return; // fokus Jabodetabek + sekitar
        mapPoints.push({ id: r.id, lat, lng, owner: r.owner_name, address: r.location_address || r.address, unit: r.unit_type, status: r.status, marketing: r.marketing_name || '-' });
      });
    } catch (e) { mapPoints = []; }

    res.render('admin/dashboard', {
      title: 'Dashboard Admin - JAP',
      totalMarketing,
      statusCounts,
      totalApproved,
      totalDownlines,
      totalLahan,
      sisaKuota: Number(sisaKuota),
      months,
      trendLabels: keys.map((k) => k.label),
      trendLahan,
      trendFee,
      deltaLahan: pct(curC, prevC),
      deltaFee: pct(curF, prevF),
      topMarketing,
      recentLands,
      mapPoints,
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

// Struktur organisasi LENGKAP semua level (Koordinator → Head → Marketing
// → Penyedia, termasuk akun terkunci + foto). Khusus admin — halaman depan
// (/struktur) sengaja hanya menampilkan ringkasannya.
exports.struktur = async (req, res) => {
  try {
    const { buildOrgTree } = require('../utils/orgTree');
    const { toBerkas } = require('../utils/fileUrl');
    const { tree, counts } = await buildOrgTree({ includeOwners: true, includeLocked: true, photoMap: toBerkas });
    res.render('admin/struktur', { title: 'Struktur Tim Lengkap - BSS', tree, counts });
  } catch (err) {
    console.error('Admin struktur error:', err);
    res.status(500).render('public/404', { title: 'Terjadi Kesalahan' });
  }
};

exports.marketing = async (req, res) => {
  try {
    // mkt_status ada setelah upgradeDb pendaftaran-marketing; fallback bila belum migrasi.
    let marketers;
    try {
      marketers = await query(
      `SELECT u.id, u.name, u.email, u.whatsapp, u.nik, u.bank_name, u.account_number, u.photo_file, u.ktp_file, u.referral_code, u.downline_quota, u.parent_id, u.is_head, u.is_coordinator, u.is_locked, u.mkt_status, u.created_at,
              p.name AS parent_name,
              (SELECT COUNT(*) FROM lands l WHERE l.marketing_id = u.id) AS total_lands,
              (SELECT COUNT(*) FROM lands l WHERE l.marketing_id = u.id AND l.status = 'approved') AS approved_lands,
              (SELECT COALESCE(SUM(f.amount),0) FROM fee_logs f WHERE f.marketing_id = u.id) AS acc_fee,
              (SELECT COALESCE(SUM(f.amount),0) FROM fee_logs f WHERE f.marketing_id = u.id AND f.status = 'unpaid') AS unpaid_fee,
              (SELECT COUNT(*) FROM users d WHERE d.parent_id = u.id) AS total_downlines
       FROM users u
       LEFT JOIN users p ON p.id = u.parent_id
       WHERE u.role = 'marketing'
       ORDER BY u.id DESC`
    );
    } catch (inner) {
      if (!inner || inner.code !== 'ER_BAD_FIELD_ERROR') throw inner;
      console.error('Admin marketing: kolom mkt_status belum ada — jalankan node config/upgradeDb.js');
      marketers = await query(
      `SELECT u.id, u.name, u.email, u.whatsapp, u.nik, u.bank_name, u.account_number, u.photo_file, u.ktp_file, u.referral_code, u.downline_quota, u.parent_id, u.is_head, u.is_coordinator, u.is_locked, u.created_at,
              p.name AS parent_name,
              (SELECT COUNT(*) FROM lands l WHERE l.marketing_id = u.id) AS total_lands,
              (SELECT COUNT(*) FROM lands l WHERE l.marketing_id = u.id AND l.status = 'approved') AS approved_lands,
              (SELECT COALESCE(SUM(f.amount),0) FROM fee_logs f WHERE f.marketing_id = u.id) AS acc_fee,
              (SELECT COALESCE(SUM(f.amount),0) FROM fee_logs f WHERE f.marketing_id = u.id AND f.status = 'unpaid') AS unpaid_fee,
              (SELECT COUNT(*) FROM users d WHERE d.parent_id = u.id) AS total_downlines
       FROM users u
       LEFT JOIN users p ON p.id = u.parent_id
       WHERE u.role = 'marketing'
       ORDER BY u.id DESC`
      );
      marketers.forEach((m) => { m.mkt_status = 'active'; });
    }

    // Hitung total jaringan (semua level) per marketing untuk para head
    const kids = {};
    marketers.forEach((m) => {
      const p = m.parent_id ? Number(m.parent_id) : 0;
      if (!kids[p]) kids[p] = [];
      kids[p].push(Number(m.id));
    });
    const netSize = (rootId) => {
      let n = 0;
      const stack = (kids[rootId] || []).slice();
      const seen = new Set([Number(rootId)]);
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        n += 1;
        (kids[id] || []).forEach((k) => stack.push(k));
      }
      return n;
    };
    marketers.forEach((m) => { m.net_total = netSize(m.id); });
    const heads = marketers.filter((m) => Number(m.is_head) === 1);
    const coords = marketers.filter((m) => Number(m.is_coordinator) === 1);

    res.render('admin/marketing', {
      title: 'Manajemen Marketing - JAP',
      marketers,
      heads,
      coords,
      DEFAULT_PASSWORD,
    });
  } catch (err) {
    console.error('Admin marketing error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.createMarketing = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    let whatsapp = String(req.body.whatsapp || '').replace(/\D/g, '');
    if (whatsapp.startsWith('0')) whatsapp = '62' + whatsapp.slice(1);
    else if (whatsapp && !whatsapp.startsWith('62')) whatsapp = '62' + whatsapp;

    // Fee per orang tidak dipakai lagi — fee otomatis dari matriks fee_rules
    // (tipe x wilayah lahan) saat approve. Kolom users.fee_type/fee_value
    // dipertahankan di skema tapi selalu NULL/0.
    const feeType = null;
    const feeValue = 0;

    if (!name || !email) {
      flash(req, 'error', 'Nama dan email wajib diisi.');
      return res.redirect('/admin/marketing');
    }

    const exist = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (exist) {
      flash(req, 'error', `Email ${email} sudah terdaftar.`);
      return res.redirect('/admin/marketing');
    }

    // Identitas: NIK + bank + rek wajib; WA & NIK tidak boleh double
    const identErr = validateMarketingIdentity(req.body);
    if (identErr) {
      flash(req, 'error', identErr);
      return res.redirect('/admin/marketing');
    }
    const bankName = resolveBankName(req.body);
    const accountNumber = normRek(req.body.account_number);
    const nik = normNik(req.body.nik);
    if (whatsapp) {
      const dupWa = await get('SELECT id FROM users WHERE whatsapp = ?', [whatsapp]);
      if (dupWa) {
        flash(req, 'error', 'No. WhatsApp sudah dipakai akun lain (tidak bisa double).');
        return res.redirect('/admin/marketing');
      }
    }
    const dupNik = await get('SELECT id FROM users WHERE nik = ?', [nik]);
    if (dupNik) {
      flash(req, 'error', 'NIK / No. KTP sudah terdaftar (tidak bisa double).');
      return res.redirect('/admin/marketing');
    }

    const referralCode = await generateReferralCode();
    const customPass = String(req.body.password || '');
    if (customPass && customPass.length < 6) {
      flash(req, 'error', 'Password minimal 6 karakter.');
      return res.redirect('/admin/marketing');
    }
    const plainPass = customPass || DEFAULT_PASSWORD;
    const hash = await bcrypt.hash(plainPass, 10);

    // Head marketing / atasan (opsional) — harus marketing lain yang sudah ada
    let parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
    if (parentId) {
      const parent = await get('SELECT id FROM users WHERE id = ? AND role = ?', [parentId, 'marketing']);
      if (!parent) {
        flash(req, 'error', 'Head marketing tidak valid.');
        return res.redirect('/admin/marketing');
      }
    } else {
      parentId = null;
    }

    await query(
      'INSERT INTO users (name, email, whatsapp, nik, bank_name, account_number, fee_type, fee_value, password, role, referral_code, parent_id, is_head, is_coordinator, downline_quota) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)',
      [name, email, whatsapp || null, nik, bankName, accountNumber, feeType, feeValue, hash, 'marketing', referralCode, parentId, req.body.is_head === '1' ? 1 : 0, req.body.is_coordinator === '1' ? 1 : 0]
    );

    flash(
      req,
      'success',
      `Marketing "${name}" berhasil dibuat. Kode referral: ${referralCode} | Password: ${plainPass}`
    );
    res.redirect('/admin/marketing');
  } catch (err) {
    console.error('Create marketing error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      flash(req, 'error', 'Gagal: Email / No. WA / NIK sudah dipakai akun lain (tidak bisa double).');
    } else {
      flash(req, 'error', 'Gagal membuat marketing.');
    }
    res.redirect('/admin/marketing');
  }
};

exports.updateMarketing = async (req, res) => {
  try {
    const id = Number(req.body.id);
    const marketing = await get('SELECT id, name FROM users WHERE id = ? AND role = ?', [id, 'marketing']);
    if (!marketing) {
      flash(req, 'error', 'Marketing tidak ditemukan.');
      return res.redirect('/admin/marketing');
    }

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    let whatsapp = String(req.body.whatsapp || '').replace(/\D/g, '');
    if (whatsapp.startsWith('0')) whatsapp = '62' + whatsapp.slice(1);
    else if (whatsapp && !whatsapp.startsWith('62')) whatsapp = '62' + whatsapp;

    // Fee per orang tidak dipakai lagi (lihat createMarketing).
    const feeType = null;
    const feeValue = 0;

    if (!name || !email) {
      flash(req, 'error', 'Nama dan email wajib diisi.');
      return res.redirect('/admin/marketing');
    }

    const exist = await get('SELECT id FROM users WHERE email = ? AND id != ?', [email, id]);
    if (exist) {
      flash(req, 'error', `Email ${email} sudah terdaftar.`);
      return res.redirect('/admin/marketing');
    }

    const identErr = validateMarketingIdentity(req.body);
    if (identErr) {
      flash(req, 'error', identErr);
      return res.redirect('/admin/marketing');
    }
    const bankName = resolveBankName(req.body);
    const accountNumber = normRek(req.body.account_number);
    const nik = normNik(req.body.nik);
    if (whatsapp) {
      const dupWa = await get('SELECT id FROM users WHERE whatsapp = ? AND id != ?', [whatsapp, id]);
      if (dupWa) {
        flash(req, 'error', 'No. WhatsApp sudah dipakai akun lain (tidak bisa double).');
        return res.redirect('/admin/marketing');
      }
    }
    const dupNik = await get('SELECT id FROM users WHERE nik = ? AND id != ?', [nik, id]);
    if (dupNik) {
      flash(req, 'error', 'NIK / No. KTP sudah terdaftar (tidak bisa double).');
      return res.redirect('/admin/marketing');
    }

    // Head marketing / atasan (opsional) — tidak boleh diri sendiri / keturunannya (cegah siklus)
    let parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
    if (parentId === id) {
      flash(req, 'error', 'Marketing tidak bisa menjadi atasannya sendiri.');
      return res.redirect('/admin/marketing');
    }
    if (parentId) {
      const parent = await get('SELECT id FROM users WHERE id = ? AND role = ?', [parentId, 'marketing']);
      if (!parent) {
        flash(req, 'error', 'Head marketing tidak valid.');
        return res.redirect('/admin/marketing');
      }
      let anc = parentId;
      for (let i = 0; i < 50 && anc; i += 1) {
        if (anc === id) {
          flash(req, 'error', 'Atasan tidak boleh bawahan dari marketing ini (siklus).');
          return res.redirect('/admin/marketing');
        }
        const row = await get('SELECT parent_id FROM users WHERE id = ?', [anc]);
        anc = row && row.parent_id ? Number(row.parent_id) : null;
      }
    } else {
      parentId = null;
    }

    await query(
      'UPDATE users SET name = ?, email = ?, whatsapp = ?, nik = ?, bank_name = ?, account_number = ?, fee_type = ?, fee_value = ?, parent_id = ?, is_head = ?, is_coordinator = ? WHERE id = ?',
      [name, email, whatsapp || null, nik, bankName, accountNumber, feeType, feeValue, parentId, req.body.is_head === '1' ? 1 : 0, req.body.is_coordinator === '1' ? 1 : 0, id]
    );

    // Reset password bila diisi
    const newPass = String(req.body.password || '');
    if (newPass) {
      if (newPass.length < 6) {
        flash(req, 'error', 'Password baru minimal 6 karakter.');
        return res.redirect('/admin/marketing');
      }
      const hashPass = await bcrypt.hash(newPass, 10);
      await query('UPDATE users SET password = ? WHERE id = ?', [hashPass, id]);
      flash(req, 'success', `Data marketing "${name}" diperbarui + password direset. Password baru: ${newPass}`);
    } else {
      flash(req, 'success', `Data marketing "${name}" berhasil diperbarui.`);
    }
    res.redirect('/admin/marketing');
  } catch (err) {
    console.error('Update marketing error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      flash(req, 'error', 'Gagal: Email / No. WA / NIK sudah dipakai akun lain (tidak bisa double).');
    } else {
      flash(req, 'error', 'Gagal memperbarui marketing.');
    }
    res.redirect('/admin/marketing');
  }
};

// Buatkan password baru untuk template WA (JSON). Password lama langsung tidak berlaku.
exports.waPassword = async (req, res) => {
  try {
    const id = Number(req.body.id);
    const marketing = await get('SELECT id, name FROM users WHERE id = ? AND role = ?', [id, 'marketing']);
    if (!marketing) return res.json({ ok: false, message: 'Marketing tidak ditemukan.' });
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let pass = 'BSS-';
    for (let i = 0; i < 5; i += 1) {
      pass += chars[Math.floor(Math.random() * chars.length)];
    }
    await query('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(pass, 10), id]);
    res.json({ ok: true, password: pass });
  } catch (err) {
    console.error('WA password error:', err);
    res.json({ ok: false, message: 'Gagal membuat password.' });
  }
};

exports.deleteMarketing = async (req, res) => {  try {
    const id = Number(req.body.id);
    const marketing = await get('SELECT id, name FROM users WHERE id = ? AND role = ?', [id, 'marketing']);
    if (!marketing) {
      flash(req, 'error', 'Marketing tidak ditemukan.');
      return res.redirect('/admin/marketing');
    }
    const hasLands = await get('SELECT id FROM lands WHERE marketing_id = ? LIMIT 1', [id]);
    if (hasLands) {
      flash(req, 'error', 'Marketing punya data lahan, hapus lebih dulu data lahannya.');
      return res.redirect('/admin/marketing');
    }
    // Fee/saldo yang masih menempel (mis. head/koor dari lahan downline) harus
    // diselesaikan dulu supaya buku mutasi tidak kehilangan pemiliknya.
    try {
      const hasFee = await get('SELECT id FROM fee_logs WHERE marketing_id = ? LIMIT 1', [id]);
      const walletRow = await get('SELECT balance FROM user_wallets WHERE user_id = ?', [id]);
      const hasWd = await get('SELECT id FROM withdrawals WHERE user_id = ? LIMIT 1', [id]);
      if (hasFee || hasWd || (walletRow && Number(walletRow.balance) !== 0)) {
        flash(req, 'error', 'Akun ini masih punya catatan fee/penarikan — selesaikan pembayarannya dulu.');
        return res.redirect('/admin/marketing');
      }
    } catch (e) {
      // Tabel dompet belum ada (belum migrasi) -> lanjut seperti perilaku lama.
      console.error('Cek dompet saat hapus marketing dilewati:', e.message);
    }
    await query('UPDATE users SET parent_id = NULL WHERE parent_id = ?', [id]);
    await query('DELETE FROM users WHERE id = ?', [id]);
    flash(req, 'success', `Marketing "${marketing.name}" dihapus.`);
    res.redirect('/admin/marketing');
  } catch (err) {
    console.error('Delete marketing error:', err);
    flash(req, 'error', 'Gagal menghapus marketing.');
    res.redirect('/admin/marketing');
  }
};

// Kunci / buka akun marketing & head (kebijakan perusahaan).
// Terkunci = tak bisa login; sesi aktif langsung ditendang middleware.
exports.toggleLock = async (req, res) => {
  try {
    const id = Number(req.body.id);
    const locked = String(req.body.locked) === '1' ? 1 : 0;
    if (!id) {
      flash(req, 'error', 'Akun tidak valid.');
      return res.redirect('/admin/marketing');
    }
    if (req.session.user && Number(req.session.user.id) === id) {
      flash(req, 'error', 'Tidak bisa mengunci akun sendiri.');
      return res.redirect('/admin/marketing');
    }
    const target = await get('SELECT id, name, role FROM users WHERE id = ?', [id]);
    if (!target) {
      flash(req, 'error', 'Akun tidak ditemukan.');
      return res.redirect('/admin/marketing');
    }
    if (target.role !== 'marketing') {
      flash(req, 'error', 'Hanya akun marketing / head yang bisa dikunci.');
      return res.redirect('/admin/marketing');
    }
    await query('UPDATE users SET is_locked = ? WHERE id = ?', [locked, id]);
    flash(req, 'success', locked
      ? `Akun "${target.name}" dikunci. Ia tak bisa login dan sesi aktifnya ditendang.`
      : `Akun "${target.name}" dibuka kembali. Ia bisa login seperti biasa.`);
    res.redirect('/admin/marketing');
  } catch (err) {
    console.error('Toggle lock error:', err);
    flash(req, 'error', 'Gagal mengubah status kunci akun.');
    res.redirect('/admin/marketing');
  }
};

// Setujui pendaftar marketing (email sudah terverifikasi) -> akun aktif + email sambutan.
exports.approveMarketing = async (req, res) => {
  try {
    const id = Number(req.body.id);
    const m = await get(
      `SELECT u.*, p.name AS ref_name, p.referral_code AS ref_code, p.id AS ref_id
       FROM users u LEFT JOIN users p ON p.id = u.parent_id
       WHERE u.id = ? AND u.role = 'marketing' LIMIT 1`,
      [id]
    );
    if (!m) {
      flash(req, 'error', 'Pendaftar tidak ditemukan.');
      return res.redirect('/admin/marketing');
    }
    if (m.mkt_status !== 'pending_approval') {
      flash(req, 'error', 'Hanya pendaftar berstatus menunggu persetujuan yang bisa disetujui.');
      return res.redirect('/admin/marketing');
    }
    await query(
      `UPDATE users SET mkt_status = 'active', is_locked = 0,
        email_verify_token = NULL, email_verify_expires = NULL WHERE id = ?`,
      [id]
    );

    const base = String((res.locals && res.locals.APP_URL) || process.env.APP_URL || '').trim().replace(/\/+$/, '');
    try {
      const { emailBrand, renderEmail, sendMailAsync } = require('../utils/mailer');
      const brand = await emailBrand();
      const html = await renderEmail('approved.ejs', {
        ...brand,
        userName: m.name,
        myRefCode: m.referral_code,
        ajukanLink: `${base}/ajukan?ref=${encodeURIComponent(m.referral_code)}`,
        rekrutLink: `${base}/daftar-marketing?ref=${encodeURIComponent(m.referral_code)}`,
        loginUrl: `${base}/login`,
        refOwner: m.ref_name || '-', refCode: m.ref_code || '-',
      });
      sendMailAsync({
        to: m.email,
        subject: `Akun Marketing ${brand.brandName} Anda AKTIF 🎉`,
        html,
        text: `Halo ${m.name}, akun Marketing Anda aktif. Login: ${base}/login. Kode referral Anda: ${m.referral_code}.`,
      });
    } catch (e) {
      console.error('Approve marketing: gagal menyiapkan email sambutan:', e.message);
    }
    try {
      const { notify } = require('../utils/notify');
      notify({
        userIds: [id, ...(m.ref_id ? [m.ref_id] : [])],
        title: `🎉 Akun Marketing "${String(m.name).slice(0, 40)}" disetujui & aktif`,
        body: `Kode referral: ${m.referral_code}. Selamat bergabung!`,
        link: '/marketing',
      }).catch(() => {});
    } catch (e) {}

    flash(req, 'success', `Pendaftar "${m.name}" disetujui — akun aktif & email sambutan terkirim.`);
    res.redirect('/admin/marketing');
  } catch (err) {
    console.error('Approve marketing error:', err);
    flash(req, 'error', 'Gagal menyetujui pendaftar.');
    res.redirect('/admin/marketing');
  }
};

// Tolak pendaftar marketing -> kirim email alasan lalu hapus akun (belum punya lahan).
exports.rejectMarketing = async (req, res) => {
  try {
    const id = Number(req.body.id);
    const reason = String(req.body.reason || '').trim().slice(0, 500)
      || 'Data belum memenuhi syarat. Silakan daftar ulang dengan data yang benar.';
    const m = await get('SELECT * FROM users WHERE id = ? AND role = ? LIMIT 1', [id, 'marketing']);
    if (!m) {
      flash(req, 'error', 'Pendaftar tidak ditemukan.');
      return res.redirect('/admin/marketing');
    }
    if (m.mkt_status !== 'pending_approval' && m.mkt_status !== 'pending_verification') {
      flash(req, 'error', 'Hanya pendaftar yang belum aktif yang bisa ditolak.');
      return res.redirect('/admin/marketing');
    }
    const hasLands = await get('SELECT id FROM lands WHERE marketing_id = ? LIMIT 1', [id]);
    if (hasLands) {
      flash(req, 'error', 'Akun ini sudah punya data lahan — tolak via penguncian akun, bukan hapus.');
      return res.redirect('/admin/marketing');
    }
    const base = String((res.locals && res.locals.APP_URL) || process.env.APP_URL || '').trim().replace(/\/+$/, '');
    try {
      const { emailBrand, renderEmail, sendMailAsync } = require('../utils/mailer');
      const brand = await emailBrand();
      const html = await renderEmail('rejected.ejs', {
        ...brand, userName: m.name, userEmail: m.email, reason,
        daftarUrl: `${base}/daftar-marketing`,
      });
      sendMailAsync({
        to: m.email,
        subject: `Informasi pendaftaran Marketing ${brand.brandName}`,
        html,
        text: `Halo ${m.name}, pendaftaran Anda belum dapat disetujui. Catatan: ${reason}`,
      });
    } catch (e) {
      console.error('Reject marketing: gagal menyiapkan email penolakan:', e.message);
    }
    await query('UPDATE users SET parent_id = NULL WHERE parent_id = ?', [id]);
    await query('DELETE FROM users WHERE id = ?', [id]);
    flash(req, 'success', `Pendaftar "${m.name}" ditolak & dihapus. Email pemberitahuan terkirim.`);
    res.redirect('/admin/marketing');
  } catch (err) {
    console.error('Reject marketing error:', err);
    flash(req, 'error', 'Gagal menolak pendaftar.');
    res.redirect('/admin/marketing');
  }
};

// Diagnostik email (khusus produksi): status SMTP, 100 baris log terakhir, kirim tes.
exports.mailLogPage = async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const { isMailConfigured, isMailerAvailable, getFrom } = require('../utils/mailer');
    let lines = [];
    // Baca ekor file saja (max 64 KB) agar tak OOM bila mail.log membengkak di produksi.
    try {
      const logPath = path.join(__dirname, '..', 'logs', 'mail.log');
      const stat = fs.statSync(logPath);
      if (stat.isFile()) {
        const TAIL = 64 * 1024;
        const start = Math.max(0, stat.size - TAIL);
        const fd = fs.openSync(logPath, 'r');
        try {
          const buf = Buffer.alloc(stat.size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          const raw = buf.toString('utf8').trim();
          lines = raw ? raw.split('\n').slice(-100).reverse() : [];
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (e) {
      console.error('Mail log read error:', e && e.message);
      lines = [];
    }
    res.render('admin/mail-log', {
      title: 'Diagnostik Email - JAP',
      smtp: {
        configured: isMailConfigured(),
        mailerMissing: !isMailerAvailable(),
        host: process.env.SMTP_HOST || '(kosong)',
        port: process.env.SMTP_PORT || '(kosong)',
        secure: process.env.SMTP_SECURE || '(kosong)',
        user: process.env.SMTP_USER || '(kosong)',
        passSet: process.env.SMTP_PASS ? 'terisi' : '(KOSONG)',
        from: getFrom(),
      },
      lines,
    });
  } catch (err) {
    console.error('Mail log page error:', (err && err.stack) || err);
    res.status(500).send('Terjadi kesalahan server (mail-log): ' + ((err && err.message) || 'unknown'));
  }
};

exports.mailTest = async (req, res) => {
  try {
    const to = String(req.body.to || '').trim().slice(0, 100);
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
      flash(req, 'error', 'Masukkan alamat email tujuan yang valid.');
      return res.redirect('/admin/mail-log');
    }
    const { sendMail } = require('../utils/mailer');
    const r = await sendMail({
      to,
      subject: '[TES] Email transaksional BSS',
      html: '<p>Ini email tes dari panel admin. Jika Anda menerima ini, konfigurasi SMTP sudah benar.</p>',
      text: 'Ini email tes dari panel admin.',
    });
    if (r.ok) flash(req, 'success', `Email tes terkirim ke ${to} (id: ${r.id}). Cek inbox & spam.`);
    else if (r.skipped && r.error) flash(req, 'error', r.error);
    else if (r.skipped) flash(req, 'error', 'SMTP belum dikonfigurasi — lengkapi SMTP_HOST/USER/PASS di environment lalu restart.');
    else flash(req, 'error', `Gagal kirim: ${r.error || 'tidak diketahui'}. Lihat log di bawah.`);
    res.redirect('/admin/mail-log');
  } catch (err) {
    console.error('Mail test error:', err);
    flash(req, 'error', 'Gagal mengirim email tes.');
    res.redirect('/admin/mail-log');
  }
};

exports.lands = async (req, res) => {  try {
    // Allowlist filter status anti-SQLi: hanya 3 nilai ini yang boleh masuk klausa WHERE.
    const allowed = ['pending', 'approved', 'rejected'];
    const statusFilter = allowed.includes(req.query.status) ? req.query.status : null;

    const lands = await query(
      `SELECT l.*, u.name marketing_name, u.referral_code,
        (SELECT COUNT(*) FROM lands s WHERE s.phone_number = l.phone_number) AS owner_units FROM lands l
       LEFT JOIN users u ON u.id = l.marketing_id
       ${statusFilter ? 'WHERE l.status = ?' : ''}
       ORDER BY l.id DESC`,
      statusFilter ? [statusFilter] : []
    );

    // Nama usaha untuk footer Pin Maker (dikosongkan = JAP dihapus).
    // Default '' agar tidak ada teks hardcoded bila pengaturan belum diisi.
    let businessName = '';
    try {
      const { getSetting } = require('../utils/settings');
      businessName = await getSetting('business_name', '');
    } catch (e) { businessName = ''; }

    // Slot multi-titik per pemilik: 1 HP bisa punya N unit,
    // dinomori terpisah per tipe (BSS-1..n, EVCS-1..n) + urutan global.
    // Dihitung dari SEMUA lahan agar konsisten di semua filter.
    let ownerSeq = {};
    try {
      const { buildSlotMap } = require('../utils/slotInfo');
      const allIds = await query('SELECT id, phone_number, unit_type, slot_no FROM lands ORDER BY id ASC');
      ownerSeq = buildSlotMap(allIds);
    } catch (e) { ownerSeq = {}; }

    // Grup 1 card: baris dengan No HP + tanggal pengajuan + titik lat/long yang
    // SAMA dianggap 1 pengajuan (mis. BSS+EVCS sekaligus) → tampil 1 card berisi
    // semua unitnya. Beda waktu atau beda titik → card terpisah.
    // Urutan unit dalam card: EVCS dulu, lalu BSS (id terbaru dulu).
    const groups = [];
    const gmap = new Map();
    lands.forEach((r) => {
      const d = r.created_at ? new Date(r.created_at) : null;
      const ymd = d && !isNaN(d.getTime())
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
      const key = `${r.phone_number || ''}||${r.lat_long || ''}||${ymd}`;
      let g = gmap.get(key);
      if (!g) {
        g = { key, phone: r.phone_number, ymd, units: [] };
        gmap.set(key, g);
        groups.push(g);
      }
      g.units.push(r);
    });
    groups.forEach((gr) => {
      gr.units.sort((a, b) => ((a.unit_type === 'evcs_mobil' ? 0 : 1) - (b.unit_type === 'evcs_mobil' ? 0 : 1)) || (b.id - a.id));
    });

    let feeMatrix = null;
    try {
      feeMatrix = await require('../utils/feeRules').getFeeMatrix();
    } catch (e) { feeMatrix = null; }

    res.render('admin/lands', { title: 'Daftar Lahan - JAP', lands, groups, statusFilter, businessName, ownerSeq, feeMatrix });
  } catch (err) {
    console.error('Admin lands error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.settingsPage = async (req, res) => {
  try {
    const { getSetting, getProposalSettings, PROPOSAL_ATTACHMENTS } = require('../utils/settings');
    const { getCompanyProfile } = require('../utils/companyProfile');
    const { getFeeMatrix, WILAYAH_LIST } = require('../utils/feeRules');
    const businessName = await getSetting('business_name', '');
    const company = await getCompanyProfile();
    const proposal = await getProposalSettings();
    const feeMatrix = await getFeeMatrix();
    const activeTab = req.query.tab === 'fee' ? 'fee' : 'profil';
    res.render('admin/settings', { title: 'Pengaturan - JAP', businessName, company, proposal, proposalAttachments: PROPOSAL_ATTACHMENTS, feeMatrix, feeWilayah: WILAYAH_LIST, activeTab });
  } catch (err) {
    console.error('Admin settings error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.saveSettings = async (req, res) => {
  const fs = require('fs');
  const path = require('path');
    try {
      const { setSetting, getSetting, PROPOSAL_ATTACHMENTS } = require('../utils/settings');
      const businessName = String(req.body.business_name || '').trim().slice(0, 100);
      await setSetting('business_name', businessName);
      // Pengaturan proposal vendor: durasi kontrak + lampiran + catatan.
      const cy = String(req.body.proposal_contract_years || '').trim();
      await setSetting('proposal_contract_years', /^[1-9]\d?$/.test(cy) ? cy : '5');
      const allowed = new Set(PROPOSAL_ATTACHMENTS.map((a) => a[0]));
      const picked = Array.isArray(req.body.proposal_attachments)
        ? req.body.proposal_attachments
        : (req.body.proposal_attachments ? [req.body.proposal_attachments] : []);
      const chosen = picked.map((s) => String(s)).filter((s) => allowed.has(s));
      await setSetting('proposal_attachments', (chosen.length ? chosen : PROPOSAL_ATTACHMENTS.map((a) => a[0])).join(','));
      await setSetting('proposal_notes', String(req.body.proposal_notes || '').trim().slice(0, 2000));
      await setSetting('proposal_vendor_a', String(req.body.proposal_vendor_a || '').trim().slice(0, 60));
      await setSetting('proposal_vendor_b', String(req.body.proposal_vendor_b || '').trim().slice(0, 60));
      // Matriks fee berjenjang (kotor): fee_bss_<wil>_<role>, fee_evcs_<wil>_<role>.
      // Validasi Koor ≥ Head ≥ Marketing ada di saveFeeMatrix; gagal simpan fee
      // tidak menggagalkan simpan profil (pesan error khusus).
      try {
        const { saveFeeMatrix, WILAYAH_LIST } = require('../utils/feeRules');
        const matrix = { bss: {}, evcs: {} };
        // Terima digit polos ("900000") maupun format ribuan ("900.000"):
        // titik pemisah dibuang, koma desimal dibulatkan ke bawah, minus ditolak.
        const toInt = (v) => {
          let s = String(v == null ? '' : v).trim();
          s = s.replace(/\./g, '').replace(/,/g, '.');
          const n = Math.floor(Number(s));
          return Number.isFinite(n) && n >= 0 ? n : 0;
        };
        for (const t of ['bss', 'evcs']) {
          for (const [wk] of WILAYAH_LIST) {
            matrix[t][wk] = {
              koordinator: toInt(req.body[`fee_${t}_${wk}_koordinator`]),
              head: toInt(req.body[`fee_${t}_${wk}_head`]),
              marketing: toInt(req.body[`fee_${t}_${wk}_marketing`]),
            };
          }
        }
        // Hanya simpan bila ada satu saja field fee yang dikirim (form settings selalu kirim).
        const hasFee = Object.keys(req.body).some((k) => /^fee_(bss|evcs)_/.test(k));
        if (hasFee) await saveFeeMatrix(matrix);
      } catch (feeErr) {
        flash(req, 'error', `Pengaturan perusahaan disimpan, tetapi fee gagal disimpan: ${feeErr.message}`);
        return res.redirect('/admin/settings?tab=fee');
      }
    // Profil perusahaan (semua opsional kecuali nama).
    // Telepon: input tanpa +62 (ada addon), simpan selalu berformat +62 ....
    const phoneDigits = String(req.body.company_phone || '').trim().replace(/^\+?62/, '').trim().slice(0, 30);
    const company = {
      company_name: String(req.body.company_name || '').trim().slice(0, 100),
      company_email: String(req.body.company_email || '').trim().slice(0, 100),
      company_phone: phoneDigits ? '+62 ' + phoneDigits : '',
      company_address1: String(req.body.company_address1 || '').trim().slice(0, 255),
      company_address2: String(req.body.company_address2 || '').trim().slice(0, 255),
      company_city: String(req.body.company_city || '').trim().slice(0, 100),
      company_province: String(req.body.company_province || '').trim().slice(0, 100),
      company_postal: String(req.body.company_postal || '').trim().slice(0, 20),
      company_country: String(req.body.company_country || '').trim().slice(0, 100),
      signer_name: String(req.body.signer_name || '').trim().slice(0, 100),
      signer_title: String(req.body.signer_title || '').trim().slice(0, 100),
    };
    for (const [k, v] of Object.entries(company)) {
      await setSetting(k, v);
    }
    // Berkas gambar: logo perusahaan + tanda tangan penandatangan.
    // Ganti bila ada upload baru, hapus bila dicentang.
    const oldLogo = await getSetting('company_logo', '');
    const oldSign = await getSetting('signature_file', '');
    const eraseImg = (p, prefix) => {
      if (!p || !p.startsWith(prefix)) return;
      fs.unlink(path.join(__dirname, '..', 'public', p.replace(/^\//, '')), () => {});
    };
    const upLogo = req.files && req.files.company_logo && req.files.company_logo[0];
    const upSign = req.files && req.files.signature_file && req.files.signature_file[0];
    if (upLogo) {
      const np = '/img/' + upLogo.filename;
      await setSetting('company_logo', np);
      if (oldLogo && oldLogo !== np) eraseImg(oldLogo, '/img/company-logo-');
    } else if (String(req.body.remove_logo || '') === '1' && oldLogo) {
      await setSetting('company_logo', '');
      eraseImg(oldLogo, '/img/company-logo-');
    }
    // Kompresi server-side untuk logo/TTD baru (best-effort, tak menggagalkan simpan).
    // Logo cuma tampil 38px di navbar: batasi 512px agar tidak jadi 861KB seperti sebelumnya.
    try {
      const { compressUploads } = require('../utils/imageCompress');
      const fresh = [];
      if (upLogo) fresh.push(upLogo);
      if (upSign) fresh.push(upSign);
      if (fresh.length) await compressUploads(fresh, { maxDim: 512 });
    } catch (e) {}
    // Segarkan favicon ber-box mengikuti logo terbaru (best-effort).
    try {
      const { ensureBoxedFavicon } = require('../utils/brandFavicon');
      const curLogo = await getSetting('company_logo', '');
      await ensureBoxedFavicon(curLogo || null);
    } catch (e) {}
    if (upSign) {
      const np = '/img/' + upSign.filename;
      await setSetting('signature_file', np);
      if (oldSign && oldSign !== np) eraseImg(oldSign, '/img/signature-');
    } else if (String(req.body.remove_signature || '') === '1' && oldSign) {
      await setSetting('signature_file', '');
      eraseImg(oldSign, '/img/signature-');
    }
    flash(req, 'success', 'Pengaturan perusahaan disimpan.');
    try { require('../utils/companyProfile').clearBrandCache(); } catch (e) {}
    res.redirect('/admin/settings?tab=' + (String(req.body.active_tab || '') === 'fee' ? 'fee' : 'profil'));
  } catch (err) {
    console.error('Save settings error:', err);
    // Jangan tinggalkan file yatim bila simpan teks gagal setelah upload.
    try {
      Object.values(req.files || {}).forEach((arr) => {
        (arr || []).forEach((f) => { if (f && f.path) fs.unlink(f.path, () => {}); });
      });
    } catch (e) {}
    flash(req, 'error', 'Gagal menyimpan pengaturan.');
    res.redirect('/admin/settings?tab=' + (String(req.body && req.body.active_tab || '') === 'fee' ? 'fee' : 'profil'));
  }
};

// Helper: terbitkan SPPL bila belum ada (dipakai saat verifikasi lolos & fallback approve).
// SATU file per penyedia (kunci phone_number): semua unit pemilik yang sama
// menunjuk sppl_file yang sama. Mengembalikan { path, created, units }.
async function ensureSppl(landId) {
  const row = await get('SELECT id, phone_number, marketing_id, sppl_file FROM lands WHERE id = ?', [landId]);
  if (!row) throw new Error('Lahan tidak ditemukan.');
  const sibs = row.phone_number
    ? await query('SELECT id, sppl_file FROM lands WHERE phone_number = ? ORDER BY id ASC', [row.phone_number])
    : [{ id: row.id, sppl_file: row.sppl_file }];
  const have = sibs.find((s) => s.sppl_file);
  if (have) {
    // Konsolidasi: unit yang belum punya ikut memakai file yang sudah ada;
    // file duplikat yatim dihapus dari disk (best-effort).
    const missing = sibs.filter((s) => !s.sppl_file).map((s) => s.id);
    if (missing.length) {
      await query(`UPDATE lands SET sppl_file = ? WHERE id IN (${missing.map(() => '?').join(',')})`, [have.sppl_file, ...missing]);
    }
    try {
      const fs = require('fs');
      const path = require('path');
      const orphans = [...new Set(sibs.map((s) => s.sppl_file).filter((p) => p && p !== have.sppl_file))];
      orphans.forEach((p) => {
        fs.unlink(path.join(__dirname, '..', 'public', String(p).replace(/^\//, '')), () => {});
      });
    } catch (e) {}
    return { path: have.sppl_file, created: false, units: sibs.length };
  }
  const { generateSpplPdf } = require('../utils/spplPdf');
  const full = await get('SELECT * FROM lands WHERE id = ?', [sibs[0].id]);
  if (!full) throw new Error('Lahan tidak ditemukan.');
  const mktSrc = full.marketing_id ? full : row;
  const mkt = mktSrc.marketing_id
    ? await get('SELECT name FROM users WHERE id = ?', [mktSrc.marketing_id])
    : null;
  let company = {};
  try {
    company = await require('../utils/companyProfile').getCompanyProfile();
  } catch (e) { company = {}; }
  const spplPath = await generateSpplPdf(full, mkt ? mkt.name : '', new Date(), company);
  const ids = sibs.map((s) => s.id);
  await query(`UPDATE lands SET sppl_file = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [spplPath, ...ids]);
  return { path: spplPath, created: true, units: ids.length };
}

exports.approveLand = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const landId = Number(req.body.land_id);

    await conn.beginTransaction();

    const [landRows] = await conn.execute('SELECT id, marketing_id, harga_sewa, harga_sewa_bss, harga_sewa_evcs, unit_type, slot_no, city, phone_number, status, survey_status FROM lands WHERE id = ? FOR UPDATE', [landId]);
    const land = landRows[0];
    if (!land) throw new Error('Lahan tidak ditemukan.');
    if (land.status === 'approved') throw new Error('Lahan sudah disetujui sebelumnya (fee tidak digandakan).');
    if ((land.survey_status || 'belum') !== 'lolos') throw new Error('Tandai survei lolos dulu sebelum menyetujui.');

    // Otomatis: nominal sewa kontrak = Harga Sewa /tahun yang sudah diisi
    // (pengaju atau admin). Tanpa harga, persetujuan ditahan.
    // Fallback ke kolom per-tipe bila cermin lama (harga_sewa) masih kosong.
    const typedHarga = land.unit_type === 'evcs_mobil' ? land.harga_sewa_evcs : land.harga_sewa_bss;
    const unitPrice = Number(land.harga_sewa) || Number(typedHarga) || 0;
    if (!unitPrice) throw new Error('Harga Sewa /tahun belum diisi. Isi dulu, lalu setujui.');
    // Qty unit = slot_no (grid slot form = jumlah unit). Total kontrak = harga × qty.
    const qty = Math.min(10, Math.max(1, Number(land.slot_no) || 1));
    const nominal = unitPrice * qty;

    // Validasi max unit per titik (1 HP = 1 pemilik): BSS max 3, EVCS max 10.
    // Hitung hanya unit yang sudah disetujui (approved), pending masih boleh.
    try {
      if (land.phone_number) {
        const [cntRows] = await conn.execute(
          `SELECT unit_type, COALESCE(SUM(COALESCE(slot_no, 1)), 0) c FROM lands WHERE phone_number = ? AND status = 'approved' GROUP BY unit_type`,
          [land.phone_number]
        );
        const counts = {};
        cntRows.forEach((r) => { counts[r.unit_type] = Number(r.c); });
        const bssCount = counts.bss_motor || 0;
        const evcsCount = counts.evcs_mobil || 0;
        if (land.unit_type === 'bss_motor' && bssCount + qty > 3) {
          throw new Error(`Melebihi max 3 unit BSS per titik untuk HP ini (${bssCount} approved + ${qty} diajukan).`);
        }
        if (land.unit_type === 'evcs_mobil' && evcsCount + qty > 10) {
          throw new Error(`Melebihi max 10 unit EVCS per titik untuk HP ini (${evcsCount} approved + ${qty} diajukan).`);
        }
      }
    } catch (e) {
      if (/Melebihi max/.test(e.message)) throw e;
      // Hitung unit gagal (DB tak konsisten) -> lanjut tanpa blokir, catat log.
      console.error('Validasi max unit dilewati:', e.message);
    }

    // Fee berjenjang (kotor -> bersih). Cegah dobel: lahan approved tak bisa di-approve ulang.
    const [dup] = await conn.execute('SELECT id FROM fee_logs WHERE land_id = ? LIMIT 1', [landId]);
    if (dup.length) throw new Error('Fee lahan ini sudah tercatat (tolak dulu bila ingin koreksi).');

    const feeMod = require('../utils/feeRules');
    const walletMod = require('../utils/wallet');
    const matrix = await feeMod.getFeeMatrix();
    const info = feeMod.getGrossFor(matrix, land.city, land.unit_type);
    const net = feeMod.splitNet(info.gross);

    let quotaAdded = false;
    let payouts = { rows: [], net, total: 0, topGross: 0 };
    let feeNote = '';
    // Peringatan bila saldo dompet mitra gagal dicatat (tabel belum dimigrasi).
    let walletWarn = '';
    // Diisi dari resolveChain untuk teks konfirmasi (peran yang merangkap).
    let chainHeadId = null;
    let chainKoorId = null;
    if (land.marketing_id) {
      const getUserTx = async (id) => {
        const [rr] = await conn.execute('SELECT id, parent_id, is_head, is_coordinator FROM users WHERE id = ? LIMIT 1', [id]);
        return rr[0] || null;
      };
      const { headId, koorId } = await feeMod.resolveChain(land.marketing_id, getUserTx);
      chainHeadId = headId;
      chainKoorId = koorId;
      payouts = feeMod.buildPayouts({ marketingId: land.marketing_id, headId, koorId, gross: info.gross });
      // amount = BERSIH (yang diterima), gross_amount = kotor rantai (audit).
      // Setiap baris fee langsung dikreditkan ke saldo dompet mitra dalam
      // transaksi yang sama, supaya hak fee bisa ditarik di /marketing/penarikan.
      for (const p of payouts.rows) {
        const [feeIns] = await conn.execute(
          'INSERT INTO fee_logs (marketing_id, fee_role, wilayah, unit_type, land_id, amount, gross_amount) VALUES (?,?,?,?,?,?,?)',
          [p.userId, p.role, info.wilayah, land.unit_type, landId, p.net * qty, p.gross * qty]
        );
        try {
          await walletMod.creditFee(conn, {
            userId: p.userId,
            amount: p.net * qty,
            feeLogId: feeIns.insertId,
            landId,
            role: p.role,
            actorId: req.session.user && req.session.user.id,
          });
        } catch (walletErr) {
          console.error('Credit fee ke dompet gagal:', walletErr.message);
          walletWarn = ' ⚠️ Saldo dompet mitra belum tercatat — jalankan "npm run upgrade-db" di server.';
        }
      }
      if (!koorId) feeNote += ' Koordinator tidak ditemukan (rantai belum lengkap).';
      // Pengaju koordinator = fee memang tidak dibagikan ke bawah (bukan rantai kurang).
      if (!headId && koorId !== land.marketing_id) feeNote += ' Head tidak ditemukan (rantai belum lengkap).';
      if (info.isFallback) feeNote += ` Kota "${land.city || '-'}" tak dikenal → pakai tarif non-DKI.`;

      const [cnt] = await conn.execute(
        `SELECT COUNT(*) total FROM lands WHERE marketing_id = ? AND status = 'approved'`,
        [land.marketing_id]
      );
      // +1 karena baris ini belum di-update statusnya saat hitung.
      const totalApproved = Number(cnt[0].total) + 1;

      if (totalApproved > 0 && totalApproved % 10 === 0) {
        await conn.execute('UPDATE users SET downline_quota = downline_quota + 1 WHERE id = ?', [
          land.marketing_id,
        ]);
        quotaAdded = true;
      }
    }

    // Lahan tanpa referral: tidak ada rantai penerima -> fee Rp 0 (hanya ditandai).
    if (!land.marketing_id) feeNote += ' Lahan TANPA referral → fee Rp 0 (tidak ada penerima).';

    // lands.fee_amount = kotor tertinggi yang hadir × qty (= keluar perusahaan bila rantai penuh).
    await conn.execute('UPDATE lands SET status = ?, fee_amount = ?, harga_sewa = ? WHERE id = ?', ['approved', (payouts.topGross || 0) * qty, nominal, landId]);

    await conn.commit();

    // SPPL utama terbit saat verifikasi lolos (lihat stageFlag).
    // Di sini hanya fallback: bila SPPL belum ada (mis. approve tanpa verifikasi),
    // terbitkan sekarang agar tidak ada lahan approved tanpa SPPL.
    let spplNote = '';
    try {
      const r = await ensureSppl(landId);
      spplNote = r.created ? ' SPPL otomatis diterbitkan.' : ' SPPL sudah terbit sebelumnya.';
    } catch (spplErr) {
      console.error('Generate SPPL error:', spplErr);
      spplNote = ' (SPPL otomatis gagal dibuat, gunakan tombol Terbitkan SPPL manual.)';
    }

    const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
    // Fee bersih yang tampil harus mengikuti aturan distribusi yang benar-benar
    // dipakai (marketing/head/koor yang merangkap) — hitung dari baris payout.
    const roleTotals = { marketing: 0, head: 0, koordinator: 0 };
    (payouts.rows || []).forEach((r) => { roleTotals[r.role] += r.net * qty; });
    const totalKeluar = Object.values(roleTotals).reduce((a, b) => a + b, 0);
    // Jelas siapa yang merangkap porsi berbeda (head yang mengajukan sendiri
    // memegang porsi marketing juga; koor yang mengajukan memegang semua).
    let merangkapNote = '';
    if (chainKoorId && chainKoorId === land.marketing_id) {
      merangkapNote = ' Pengaju koordinator → fee tidak dibagikan ke bawah.';
    } else if (chainHeadId && chainHeadId === land.marketing_id) {
      const headTotal = roleTotals.head + roleTotals.marketing;
      merangkapNote = ` Pengaju head → porsi marketing ikut dipegangnya (total head Rp ${Number(headTotal).toLocaleString('id-ID')}).`;
    }
    flash(
      req,
      'success',
      `Lahan #${landId} disetujui (${qty} unit). Sewa Rp ${nominal.toLocaleString('id-ID')}/thn → kotor Rp ${fmt(payouts.topGross * qty)} (bersih: koor Rp ${fmt(roleTotals.koordinator)}, head Rp ${fmt(roleTotals.head)}, marketing Rp ${fmt(roleTotals.marketing)}${roleTotals.koordinator + roleTotals.head + roleTotals.marketing !== payouts.topGross * qty ? ', total keluar Rp ' + fmt(totalKeluar) : ''}).${merangkapNote}${quotaAdded ? ' Marketing mendapat +1 kuota downline.' : ''}${feeNote}${walletWarn}${spplNote}`
    );
    const recipientIds = [...new Set(payouts.rows.map((r) => r.userId))];
    if (recipientIds.length) {
      try {
        const { notify } = require('../utils/notify');
        const bodyByUser = {};
        payouts.rows.forEach((p) => {
          // Satu user bisa memegang 2 baris (head pengaju) — gabungkan agar tak menimpa.
          const line = `• Peran ${p.role} × ${qty} unit: bersih Rp ${fmt(p.net * qty)} (kotor Rp ${fmt(p.gross * qty)})`;
          bodyByUser[p.userId] = bodyByUser[p.userId]
            ? bodyByUser[p.userId] + '\n' + line
            : `Sewa Rp ${nominal.toLocaleString('id-ID')}/thn (${qty} unit).\n` + line;
        });
        for (const uid of recipientIds) {
          notify({
            senderId: req.session.user.id, userIds: [uid],
            title: `✅ Lahan #${landId} disetujui`,
            body: bodyByUser[uid] || `Lahan #${landId} disetujui.`,
            link: '/marketing',
          }).catch(() => {});
        }
      } catch (e) {}
    }
    backToLands(req, res);
  } catch (err) {
    await conn.rollback();
    console.error('Approve land error:', err);
    flash(req, 'error', `Gagal menyetujui: ${err.message}`);
    backToLands(req, res);
  } finally {
    conn.release();
  }
};

// Proposal gabungan 1 penyedia: semua unit (BSS 1-4 + EVCS 1-4) dalam satu PDF.
exports.ownerProposalPdf = async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    if (!phone) {
      flash(req, 'error', 'Nomor penyedia tidak valid.');
      return backToLands(req, res);
    }
    const units = await query(
      `SELECT l.*, u.name marketing_name, u.referral_code FROM lands l
       LEFT JOIN users u ON u.id = l.marketing_id
       WHERE l.phone_number = ? ORDER BY l.id ASC`,
      [phone]
    );
    if (!units.length) {
      flash(req, 'error', 'Tidak ada pengajuan untuk nomor ini.');
      return backToLands(req, res);
    }
    let slotMap = {};
    try {
      const { buildSlotMap } = require('../utils/slotInfo');
      slotMap = buildSlotMap(units.map((r) => ({
        id: r.id, phone_number: r.phone_number, unit_type: r.unit_type, slot_no: r.slot_no,
      })));
    } catch (e) { slotMap = {}; }
    const marketingNames = {};
    units.forEach((u) => {
      if (u.marketing_id && u.marketing_name) marketingNames[u.marketing_id] = u.marketing_name;
    });
    const { generateOwnerProposalPdf } = require('../utils/proposalPdf');
    let brandShort = 'BSS';
    try {
      brandShort = (await require('../utils/companyProfile').getBrand()).name || 'BSS';
    } catch (e) {}
    const out = await generateOwnerProposalPdf({ owner: units[0], units, slotMap, brandShort, marketingNames });
    return res.download(out.absPath, out.fileName);
  } catch (err) {
    console.error('Owner proposal PDF error:', err);
    flash(req, 'error', 'Gagal membuat proposal penyedia.');
    return backToLands(req, res);
  }
};

exports.proposalPdf = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      flash(req, 'error', 'Pengajuan tidak valid.');
      return backToLands(req, res);
    }
    const rows = await query(
      `SELECT l.*, u.name marketing_name, u.referral_code FROM lands l
       LEFT JOIN users u ON u.id = l.marketing_id
       WHERE l.id = ? LIMIT 1`,
      [id]
    );
    if (!rows.length) {
      flash(req, 'error', 'Pengajuan tidak ditemukan.');
      return backToLands(req, res);
    }
    const land = rows[0];
    // Fee yang tampil = TOTAL bersih berjenjang (fee_logs), bukan nominal perolehan.
    // Lahan lama yang disetujui sebelum fee_logs ada -> fallback ke fee_amount.
    const feeRow = await get('SELECT COALESCE(SUM(amount),0) total FROM fee_logs WHERE land_id = ?', [id]);
    const feeMarketing = feeRow && Number(feeRow.total) > 0 ? Number(feeRow.total) : Number(land.fee_amount || 0);
    // Slot unit untuk pemilik ini (BSS-n / EVCS-n).
    let slot = null;
    try {
      const { buildSlotMap } = require('../utils/slotInfo');
      const sibs = await query('SELECT id, phone_number, unit_type, slot_no FROM lands WHERE phone_number = ? ORDER BY id ASC', [land.phone_number]);
      slot = buildSlotMap(sibs)[id] || null;
    } catch (e) { slot = null; }
    const { generateProposalPdf } = require('../utils/proposalPdf');
    let brandShort = 'BSS';
    try {
      brandShort = (await require('../utils/companyProfile').getBrand()).name || 'BSS';
    } catch (e) {}
    const out = await generateProposalPdf(land, land.marketing_name || '', feeMarketing, slot, brandShort);
    return res.download(out.absPath, out.fileName);
  } catch (err) {
    console.error('Proposal PDF error:', err);
    flash(req, 'error', 'Gagal membuat proposal PDF.');
    return backToLands(req, res);
  }
};

// Kumpulkan id lahan dari form: dukung multi-id (land_ids "1,2,3" dari workflow
// gabungan 1 card) maupun tunggal (land_id lama). Maks 20 id per aksi.
function parseLandIds(req) {
  const raw = req.body.land_ids != null && String(req.body.land_ids).trim() !== ''
    ? String(req.body.land_ids)
    : String(req.body.land_id != null ? req.body.land_id : '');
  const ids = [...new Set(
    raw.split(',').map((s) => Number(String(s).trim())).filter((n) => Number.isInteger(n) && n > 0)
  )].slice(0, 20);
  return ids;
}

exports.requestFix = async (req, res) => {
  try {
    const ids = parseLandIds(req);
    if (!ids.length) {
      flash(req, 'error', 'Pengajuan tidak valid.');
      return backToLands(req, res);
    }
    for (const landId of ids) {
      const token = require('crypto').randomBytes(32).toString('hex');
      await query('UPDATE lands SET edit_token = ?, edit_expires = DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE id = ?', [token, landId]);
    }
    // Kabari marketing pemilik agar meneruskan ke penyedia lahan.
    try {
      const mktRows = await query(
        `SELECT DISTINCT marketing_id AS mid FROM lands WHERE id IN (${ids.map(() => '?').join(',')})`, ids
      );
      const mktIds = mktRows.map((r) => r.mid).filter(Boolean);
      if (mktIds.length) {
        const { notify } = require('../utils/notify');
        notify({
          senderId: req.session.user.id, userIds: mktIds,
          title: `✏️ Lahan #${ids.join(', #')} perlu perbaikan`,
          body: 'Admin meminta perbaikan data. Link perbaikan berlaku 7 hari — cek halaman lahan Anda.',
          link: '/marketing',
        }).catch(() => {});
      }
    } catch (e) {}
    flash(req, 'success', `Link perbaikan lahan #${ids.join(', #')} dibuat (berlaku 7 hari). Klik "Buka WA" untuk mengirim ke pemilik.`);
    backToLands(req, res);
  } catch (err) {
    console.error('Request fix error:', err);
    flash(req, 'error', 'Gagal membuat link perbaikan.');
    backToLands(req, res);
  }
};

exports.stageFlag = async (req, res) => {
  try {
    const ids = parseLandIds(req);
    const field = String(req.body.field || '');
    const value = String(req.body.value || '');
    // Allowlist kolom & nilai: satu-satunya bagian SQL yang dinamis di file ini.
    // Selain dua kolom ini, query selalu memakai placeholder (?) — aman dari injeksi SQL.
    const okField = field === 'verify_status' || field === 'survey_status';
    const okValue = value === 'belum' || value === 'lolos' || value === 'gagal';
    if (!ids.length || !okField || !okValue) {
      flash(req, 'error', 'Data tanda tidak valid.');
      return backToLands(req, res);
    }
    await query(`UPDATE lands SET ${field} = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [value, ...ids]);
    const lbl = field === 'verify_status' ? 'Verifikasi' : 'Survei';
    const vLbl = value === 'lolos' ? '✓ lolos' : value === 'gagal' ? '✕ gagal' : 'direset ke belum';
    // SPPL terbit otomatis tepat setelah verifikasi dinyatakan lolos (1 file per penyedia).
    let spplNote = '';
    if (field === 'verify_status' && value === 'lolos') {
      let created = 0, failed = 0, units = 0;
      const seen = new Set();
      for (const landId of ids) {
        try {
          const r = await ensureSppl(landId);
          if (r.created) created += 1;
          if (r.path && !seen.has(r.path)) { seen.add(r.path); units += (r.units || 1); }
        } catch (spplErr) {
          console.error('Generate SPPL on verify error:', spplErr);
          failed += 1;
        }
      }
      spplNote = created
        ? ` SPPL otomatis diterbitkan (${created} file untuk ${units} unit).`
        : (failed ? ' (SPPL otomatis gagal dibuat, gunakan tombol Terbitkan SPPL manual.)' : ' SPPL sudah ada sebelumnya.');
    }
    flash(req, 'success', `${lbl} lahan #${ids.join(', #')}: ${vLbl}.${spplNote}`);
    backToLands(req, res);
  } catch (err) {
    console.error('Stage flag error:', err);
    flash(req, 'error', 'Gagal menyimpan tanda.');
    backToLands(req, res);
  }
};

// Terbitkan / terbitkan ulang SPPL secara manual (mis. gagal otomatis sebelumnya,
// atau data pemilik berubah setelah verifikasi lolos).
exports.regenerateSppl = async (req, res) => {
  try {
    const landId = Number(req.body.land_id);
    if (!landId) {
      flash(req, 'error', 'Pengajuan tidak valid.');
      return backToLands(req, res);
    }
    const land = await get('SELECT id, phone_number, verify_status, sppl_file FROM lands WHERE id = ?', [landId]);
    if (!land) {
      flash(req, 'error', 'Lahan tidak ditemukan.');
      return res.redirect('/admin/lands');
    }
    if ((land.verify_status || 'belum') !== 'lolos') {
      flash(req, 'error', `SPPL hanya bisa diterbitkan setelah verifikasi lolos (status verifikasi: ${land.verify_status || 'belum'}).`);
      return res.redirect('/admin/lands');
    }
    const fs = require('fs');
    const path = require('path');
    const sibs = land.phone_number
      ? await query('SELECT id, sppl_file FROM lands WHERE phone_number = ? ORDER BY id ASC', [land.phone_number])
      : [{ id: land.id, sppl_file: land.sppl_file }];
    // Hapus SEMUA file lama milik penyedia ini sekali jalan agar tidak yatim, lalu buat 1 baru.
    const olds = [...new Set(sibs.map((s) => s.sppl_file).filter(Boolean))];
    olds.forEach((p) => {
      try {
        fs.unlink(path.join(__dirname, '..', 'public', String(p).replace(/^\//, '')), () => {});
      } catch (e) {}
    });
    const sibIds = sibs.map((s) => s.id);
    await query(`UPDATE lands SET sppl_file = NULL WHERE id IN (${sibIds.map(() => '?').join(',')})`, sibIds);
    const r = await ensureSppl(landId);
    flash(req, 'success', `SPPL penyedia diterbitkan 1 file untuk ${sibIds.length} unit: ${r.path}`);
    backToLands(req, res);
  } catch (err) {
    console.error('Regenerate SPPL error:', err);
    flash(req, 'error', `Gagal menerbitkan SPPL: ${err.message}`);
    backToLands(req, res);
  }
};

exports.rejectLand = async (req, res) => {
  try {
    const landId = Number(req.body.land_id);
    const land = await get('SELECT id, marketing_id, owner_name FROM lands WHERE id = ?', [landId]);
    await query('UPDATE lands SET status = ?, fee_amount = 0 WHERE id = ?', ['rejected', landId]);
    // Persetujuan gugur -> fee yang pernah tercatat ikut batal (anti fee yatim).
    // Saldo dompet mitra dikoreksi DULU (mutasi reversal tercatat), baru baris fee dihapus.
    let revNote = '';
    try {
      const walletMod = require('../utils/wallet');
      const rev = await walletMod.reverseFeesForLand(null, {
        landId,
        note: `Pembatalan fee lahan #${landId} (lahan ditolak)`,
        actorId: req.session.user && req.session.user.id,
      });
      if (rev.count) revNote = ` Saldo mitra dikoreksi Rp ${Number(rev.total).toLocaleString('id-ID')}.`;
    } catch (e) {
      console.error('Reversal saldo saat tolak lahan gagal:', e.message);
      revNote = ' ⚠️ Koreksi saldo mitra dilewati (tabel dompet belum siap).';
    }
    await query('DELETE FROM fee_logs WHERE land_id = ?', [landId]);
    if (land && land.marketing_id) {
      try {
        const { notify } = require('../utils/notify');
        notify({
          senderId: req.session.user.id, userIds: [land.marketing_id],
          title: `❌ Lahan #${landId} ditolak`,
          body: `Pengajuan atas nama ${land.owner_name || '-'} ditolak admin. Fee terkait dibatalkan.`,
          link: '/marketing',
        }).catch(() => {});
      } catch (e) {}
    }
    flash(req, 'success', `Lahan #${landId} ditolak. Fee terkait (bila ada) dibatalkan.${revNote}`);
    backToLands(req, res);
  } catch (err) {
    console.error('Reject land error:', err);
    flash(req, 'error', 'Gagal menolak lahan.');
    backToLands(req, res);
  }
};

// Isi / ubah harga sewa tahunan oleh admin (pengaju boleh mengosongkan).
exports.updateHarga = async (req, res) => {
  try {
    const landId = Number(req.body.land_id);
    if (!landId) {
      flash(req, 'error', 'Pengajuan tidak valid.');
      return backToLands(req, res);
    }
    const land = await get('SELECT id, unit_type FROM lands WHERE id = ?', [landId]);
    if (!land) {
      flash(req, 'error', 'Lahan tidak ditemukan.');
      return backToLands(req, res);
    }
    // Tulis ke kolom tipe unit + cermin kolom lama.
    const priceCol = land.unit_type === 'evcs_mobil' ? 'harga_sewa_evcs' : 'harga_sewa_bss';
    const raw = String(req.body.harga_sewa == null ? '' :
req.body.harga_sewa).trim();
    if (!raw) {
      await query(`UPDATE lands SET harga_sewa = NULL, ${priceCol} = NULL WHERE id = ?`, [landId]);
      flash(req, 'success', `Harga sewa lahan #${landId} dikosongkan.`);
      return backToLands(req, res);
    }
    const { normHarga, validateHargaSewa } = require('../utils/ownerFields');
    const errMsg = validateHargaSewa({ unit_type: land.unit_type, harga_sewa: raw });
    if (errMsg) {
      flash(req, 'error', errMsg);
      return backToLands(req, res);
    }
    await query(`UPDATE lands SET harga_sewa = ?, ${priceCol} = ? WHERE id = ?`,
[normHarga(land.unit_type, raw), normHarga(land.unit_type, raw), landId]);
    flash(req, 'success', `Harga sewa lahan #${landId} disimpan.`);
    backToLands(req, res);
  } catch (err) {
    console.error('Update harga error:', err);
    flash(req, 'error', 'Gagal menyimpan harga sewa.');
    backToLands(req, res);
  }
};

// Halaman kirim notifikasi (admin -> head/marketing/admin) + riwayat terkirim.
exports.notifPage = async (req, res) => {
  try {
    const marketers = await query(
      `SELECT id, name, referral_code, is_head FROM users WHERE role = 'marketing' ORDER BY name ASC`
    );
    const sent = await query(
      `SELECT title, body, COUNT(*) n, MAX(created_at) created_at FROM notifications
       WHERE sender_id = ? GROUP BY title, body ORDER BY MAX(id) DESC LIMIT 20`,
      [req.session.user.id]
    );
    res.render('admin/notifikasi', { title: 'Kirim Notifikasi - JAP', marketers, sent });
  } catch (err) {
    console.error('Notif page error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.sendNotif = async (req, res) => {
  try {
    const { notify } = require('../utils/notify');
    const audience = String(req.body.audience || '');
    const title = String(req.body.title || '').trim().slice(0, 150);
    const body = String(req.body.body || '').trim().slice(0, 2000);
    const link = String(req.body.link || '').trim().slice(0, 500) || null;
    if (!title) {
      flash(req, 'error', 'Judul wajib diisi.');
      return res.redirect('/admin/notifikasi');
    }
    let n = 0;
    if (audience === 'user') {
      const uid = Number(req.body.user_id);
      if (!uid) {
        flash(req, 'error', 'Pilih marketing tujuan.');
        return res.redirect('/admin/notifikasi');
      }
      n = await notify({ senderId: req.session.user.id, userIds: [uid], title, body, link });
    } else if (['all_marketing', 'heads', 'admins'].includes(audience)) {
      n = await notify({ senderId: req.session.user.id, audience, title, body, link });
    } else {
      flash(req, 'error', 'Tujuan tidak valid.');
      return res.redirect('/admin/notifikasi');
    }
    flash(req, n ? 'success' : 'error', n
      ? `Notifikasi terkirim ke ${n} penerima.`
      : 'Tidak ada penerima (akun tujuan terkunci / tidak ditemukan).');
    res.redirect('/admin/notifikasi');
  } catch (err) {
    console.error('Send notif error:', err);
    flash(req, 'error', 'Gagal mengirim notifikasi.');
    res.redirect('/admin/notifikasi');
  }
};

// ---- Manajemen User (akun admin): daftar + tambah + kunci + hapus ----
// Role 'admin' setara superadmin untuk seluruh halaman /admin.
// Akun superadmin dilindungi: tak bisa dikunci/dihapus lewat sini,
// dan tak bisa mengunci/menghapus akun sendiri.
exports.usersPage = async (req, res) => {
  try {
    const users = await query(
      `SELECT id, name, email, whatsapp, role, is_locked, created_at
       FROM users WHERE role IN ('superadmin','admin') ORDER BY id ASC`
    );
    res.render('admin/users', {
      title: 'Manajemen User - JAP',
      users,
      meId: Number(req.session.user.id),
      DEFAULT_PASSWORD,
    });
  } catch (err) {
    console.error('Admin users page error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.createUser = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    let whatsapp = String(req.body.whatsapp || '').replace(/\D/g, '');
    if (whatsapp.startsWith('0')) whatsapp = '62' + whatsapp.slice(1);
    else if (whatsapp && !whatsapp.startsWith('62')) whatsapp = '62' + whatsapp;

    if (!name || !email) {
      flash(req, 'error', 'Nama dan email wajib diisi.');
      return res.redirect('/admin/users');
    }
    const exist = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (exist) {
      flash(req, 'error', `Email ${email} sudah terdaftar.`);
      return res.redirect('/admin/users');
    }
    if (whatsapp) {
      const dupWa = await get('SELECT id FROM users WHERE whatsapp = ?', [whatsapp]);
      if (dupWa) {
        flash(req, 'error', 'No. WhatsApp sudah dipakai akun lain (tidak bisa double).');
        return res.redirect('/admin/users');
      }
    }
    const customPass = String(req.body.password || '');
    if (customPass && customPass.length < 6) {
      flash(req, 'error', 'Password minimal 6 karakter.');
      return res.redirect('/admin/users');
    }
    const plainPass = customPass || DEFAULT_PASSWORD;
    const hash = await bcrypt.hash(plainPass, 10);

    await query(
      'INSERT INTO users (name, email, whatsapp, password, role) VALUES (?,?,?,?,?)',
      [name, email, whatsapp || null, hash, 'admin']
    );
    flash(req, 'success', `User admin "${name}" berhasil dibuat. Password: ${plainPass}`);
    res.redirect('/admin/users');
  } catch (err) {
    console.error('Create user error:', err);
    flash(req, 'error', err.code === 'ER_DUP_ENTRY'
      ? 'Gagal: Email / No. WA sudah dipakai akun lain.'
      : 'Gagal membuat user admin.');
    res.redirect('/admin/users');
  }
};

exports.toggleUserLock = async (req, res) => {
  try {
    const id = Number(req.body.id);
    const locked = String(req.body.locked) === '1' ? 1 : 0;
    if (!id) {
      flash(req, 'error', 'Akun tidak valid.');
      return res.redirect('/admin/users');
    }
    if (req.session.user && Number(req.session.user.id) === id) {
      flash(req, 'error', 'Tidak bisa mengunci akun sendiri.');
      return res.redirect('/admin/users');
    }
    const target = await get('SELECT id, name, role FROM users WHERE id = ?', [id]);
    if (!target || (target.role !== 'admin' && target.role !== 'superadmin')) {
      flash(req, 'error', 'Akun tidak ditemukan.');
      return res.redirect('/admin/users');
    }
    if (target.role === 'superadmin') {
      flash(req, 'error', 'Akun superadmin dilindungi dan tidak bisa dikunci.');
      return res.redirect('/admin/users');
    }
    await query('UPDATE users SET is_locked = ? WHERE id = ?', [locked, id]);
    flash(req, 'success', locked
      ? `Akun "${target.name}" dikunci. Ia tak bisa login dan sesi aktifnya ditendang.`
      : `Akun "${target.name}" dibuka kembali. Ia bisa login seperti biasa.`);
    res.redirect('/admin/users');
  } catch (err) {
    console.error('Toggle user lock error:', err);
    flash(req, 'error', 'Gagal mengubah status kunci akun.');
    res.redirect('/admin/users');
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const id = Number(req.body.id);
    const target = await get('SELECT id, name, role FROM users WHERE id = ?', [id]);
    if (!target || (target.role !== 'admin' && target.role !== 'superadmin')) {
      flash(req, 'error', 'Akun tidak ditemukan.');
      return res.redirect('/admin/users');
    }
    if (target.role === 'superadmin') {
      flash(req, 'error', 'Akun superadmin dilindungi dan tidak bisa dihapus.');
      return res.redirect('/admin/users');
    }
    if (req.session.user && Number(req.session.user.id) === id) {
      flash(req, 'error', 'Tidak bisa menghapus akun sendiri.');
      return res.redirect('/admin/users');
    }
    // Jejak audit (pemroses pembayaran / pembuat mutasi) harus utuh:
    // akun yang tercatat di sana tidak boleh dihapus.
    try {
      const ref = await get(
        'SELECT ((SELECT COUNT(*) FROM withdrawals WHERE processed_by = ?) + (SELECT COUNT(*) FROM wallet_ledger WHERE actor_id = ?)) AS n',
        [id, id]
      );
      if (ref && Number(ref.n) > 0) {
        flash(req, 'error', 'Akun ini tercatat sebagai pemroses pembayaran — tidak bisa dihapus (kunci saja bila perlu).');
        return res.redirect('/admin/users');
      }
    } catch (e) {
      console.error('Cek audit saat hapus user dilewati:', e.message);
    }
    await query('DELETE FROM users WHERE id = ?', [id]);
    flash(req, 'success', `User admin "${target.name}" dihapus.`);
    res.redirect('/admin/users');
  } catch (err) {
    console.error('Delete user error:', err);
    flash(req, 'error', 'Gagal menghapus user admin.');
    res.redirect('/admin/users');
  }
};

// ---- Profil & password akun admin yang login ----
exports.showProfile = async (req, res) => {
  try {
    const me = await get(
      'SELECT id, name, email, whatsapp, role, created_at FROM users WHERE id = ?',
      [req.session.user.id]
    );
    if (!me) return res.redirect('/login');
    res.render('admin/profil', { title: 'Profil Saya - JAP', me });
  } catch (err) {
    console.error('Admin profile page error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const userId = Number(req.session.user.id);
    const name = String(req.body.name || '').trim();
    let whatsapp = String(req.body.whatsapp || '').replace(/\D/g, '');
    if (whatsapp.startsWith('0')) whatsapp = '62' + whatsapp.slice(1);
    else if (whatsapp && !whatsapp.startsWith('62')) whatsapp = '62' + whatsapp;
    if (!name) {
      flash(req, 'error', 'Nama wajib diisi.');
      return res.redirect('/admin/profil');
    }
    if (whatsapp) {
      const dupWa = await get('SELECT id FROM users WHERE whatsapp = ? AND id != ?', [whatsapp, userId]);
      if (dupWa) {
        flash(req, 'error', 'No. WhatsApp sudah dipakai akun lain (tidak bisa double).');
        return res.redirect('/admin/profil');
      }
    }
    await query('UPDATE users SET name = ?, whatsapp = ? WHERE id = ?', [name, whatsapp || null, userId]);
    req.session.user.name = name;
    flash(req, 'success', 'Profil berhasil disimpan.');
    res.redirect('/admin/profil');
  } catch (err) {
    console.error('Admin profile update error:', err);
    flash(req, 'error', err.code === 'ER_DUP_ENTRY'
      ? 'Gagal: No. WA sudah dipakai akun lain.'
      : 'Gagal menyimpan profil.');
    res.redirect('/admin/profil');
  }
};

exports.showPassword = async (req, res) => {
  try {
    const me = await get('SELECT id, name FROM users WHERE id = ?', [req.session.user.id]);
    if (!me) return res.redirect('/login');
    res.render('admin/password', { title: 'Ganti Password - JAP', me });
  } catch (err) {
    console.error('Admin password page error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

exports.updatePassword = async (req, res) => {
  try {
    const userId = Number(req.session.user.id);
    const oldPass = String(req.body.old_password || '');
    const newPass = String(req.body.new_password || '');
    const confirmPass = String(req.body.confirm_password || '');

    if (!oldPass || !newPass || !confirmPass) {
      flash(req, 'error', 'Semua kolom wajib diisi.');
      return res.redirect('/admin/password');
    }
    if (newPass.length < 6) {
      flash(req, 'error', 'Password baru minimal 6 karakter.');
      return res.redirect('/admin/password');
    }
    if (newPass !== confirmPass) {
      flash(req, 'error', 'Konfirmasi password tidak sama.');
      return res.redirect('/admin/password');
    }

    const user = await get('SELECT password FROM users WHERE id = ?', [userId]);
    if (!user || !(await bcrypt.compare(oldPass, user.password))) {
      flash(req, 'error', 'Password lama salah.');
      return res.redirect('/admin/password');
    }

    await query('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(newPass, 10), userId]);
    flash(req, 'success', 'Password berhasil diganti.');
    res.redirect('/admin/password');
  } catch (err) {
    console.error('Admin password update error:', err);
    flash(req, 'error', 'Gagal mengganti password.');
    res.redirect('/admin/password');
  }
};
