// Penarikan dana fee oleh mitra + pemrosesan pembayaran oleh admin.
//
// Alur:
//   mitra  -> /marketing/penarikan        (lihat saldo & mutasi, ajukan/batalkan)
//   admin  -> /admin/pembayaran           (laporan + proses/dibayarkan/tolak)
//
// Saldo & mutasi dikelola utils/wallet.js (tabel user_wallets + wallet_ledger).
// Pengajuan yang masih pending/diproses menahan saldo (mutasi debit) sehingga
// tidak mungkin ditarik dua kali; penolakan/pembatalan mengembalikannya.
const fs = require('fs');
const pool = require('../config/database');
const { query, get } = require('../models/db');
const wallet = require('../utils/wallet');

const STATUS_LABEL = {
  pending: 'Menunggu diproses',
  processing: 'Sedang diproses',
  paid: 'Sudah dibayarkan',
  rejected: 'Ditolak',
  cancelled: 'Dibatalkan pengaju',
};

function flash(req, type, message) {
  req.session.flash = { type, message };
}

// Bukti transfer yang sudah terunggah tapi aksinya gagal tidak perlu disimpan.
function dropProof(req) {
  if (!req.file || !req.file.path) return;
  fs.unlink(req.file.path, () => {});
}

function sessionUserId(req) {
  const id = Number(req.session.user && req.session.user.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function rupiah(n) {
  return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
}

function appBase(res) {
  return String((res.locals && res.locals.APP_URL) || process.env.APP_URL || '').trim().replace(/\/+$/, '');
}

// Email fire-and-forget (lihat utils/mailer.js) — jangan menahan respons.
function mailTo(to, subject, data, text) {
  if (!to) return;
  try {
    const { emailBrand, renderEmail, sendMailAsync } = require('../utils/mailer');
    emailBrand()
      .then((brand) => renderEmail('withdrawal.ejs', { ...brand, ...data }))
      .then((html) => sendMailAsync({ to, subject, html, text }))
      .catch((e) => console.error('[wallet] email dilewati:', e && e.message));
  } catch (e) {
    console.error('[wallet] email dilewati:', e && e.message);
  }
}

async function mailAdmins(subject, data, text) {
  try {
    const rows = await query(
      "SELECT email FROM users WHERE role = 'superadmin' AND email IS NOT NULL AND email <> ''"
    );
    const to = rows.map((r) => r.email).join(',');
    mailTo(to, subject, data, text);
  } catch (e) {
    console.error('[wallet] email admin dilewati:', e && e.message);
  }
}

async function notifyAdmins(senderId, title, body, link) {
  try {
    const { notify } = require('../utils/notify');
    await notify({ senderId, audience: 'admins', title, body, link });
  } catch (e) {
    console.error('[wallet] notifikasi admin dilewati:', e && e.message);
  }
}

async function notifyUser(userId, title, body, link) {
  try {
    const { notify } = require('../utils/notify');
    await notify({ userIds: [userId], title, body, link });
  } catch (e) {
    console.error('[wallet] notifikasi mitra dilewati:', e && e.message);
  }
}

// ---------------------------------------------------------------- MITRA

// Halaman penarikan: saldo, buku mutasi, riwayat pengajuan, form ajukan.
exports.userPage = async (req, res) => {
  try {
    const userId = sessionUserId(req);
    if (!userId) return res.redirect('/login');

    const me = await get(
      `SELECT id, name, email, whatsapp, bank_name, account_number, wilayah,
              nik, ktp_file
       FROM users WHERE id = ?`,
      [userId]
    );
    const summary = await wallet.getWalletSummary(userId);
    const ledger = await wallet.getLedger(userId, 60);
    let requests = [];
    try {
      requests = await query(
        `SELECT id, amount, bank_name, account_number, account_name, status,
                admin_note, reject_reason, transfer_ref, proof_file,
                requested_at, processed_at, paid_at
         FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100`,
        [userId]
      );
    } catch (e) {
      // Tabel belum dimigrasi -> halaman tetap terbuka dengan peringatan.
      console.error('Daftar penarikan error:', e.message);
    }

    res.render('marketing/penarikan', {
      title: 'Penarikan Dana - BSS',
      me,
      summary,
      ledger,
      requests,
      statusLabel: STATUS_LABEL,
      minWithdraw: await wallet.minWithdraw(),
      bankReady: Boolean(me && me.bank_name && me.account_number),
      ktpReady: Boolean(me && me.nik && me.ktp_file),
    });
  } catch (err) {
    console.error('Penarikan user page error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

// Kirim OTP penarikan ke email mitra (dipanggil popup sebelum submit).
// Respond JSON agar popup tahu kode terkirim / gagal.
exports.requestOtp = async (req, res) => {
  const userId = sessionUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: 'Sesi habis. Login ulang.' });
  try {
    const amount = wallet.toAmount(req.body.amount);
    const min = await wallet.minWithdraw();
    if (!amount) return res.status(400).json({ ok: false, message: 'Isi nominal penarikan dulu.' });
    if (amount < min) return res.status(400).json({ ok: false, message: `Nominal minimal penarikan ${rupiah(min)}.` });

    const me = await get(
      'SELECT id, name, email, bank_name, account_number, nik, ktp_file FROM users WHERE id = ?',
      [userId]
    );
    if (!me) return res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' });
    if (!me.bank_name || !me.account_number) {
      return res.status(400).json({ ok: false, message: 'Lengkapi rekening di Profil dulu.', redirect: '/marketing/profil' });
    }
    if (!me.nik || !me.ktp_file) {
      return res.status(400).json({ ok: false, message: 'Verifikasi KTP dulu di Profil (NIK + foto KTP) sebelum menarik dana.', redirect: '/marketing/profil' });
    }
    if (!me.email) return res.status(400).json({ ok: false, message: 'Email akun kosong. Hubungi admin.' });

    const summary = await wallet.getWalletSummary(userId);
    if (amount > summary.balance) {
      return res.status(400).json({ ok: false, message: `Saldo tersedia hanya ${rupiah(summary.balance)}.` });
    }

    const { requestOtp, OTP_TTL_MINUTES } = require('../utils/withdrawOtp');
    const made = await requestOtp(userId, amount);
    if (!made.ok) return res.status(429).json({ ok: false, message: made.error, retryAfter: made.retryAfter || 0 });

    // Tunggu hasil kirim agar popup akurat (bukan fire-and-forget).
    const { emailBrand, renderEmail, sendMail } = require('../utils/mailer');
    const brand = await emailBrand();
    const html = await renderEmail('withdrawal-otp.ejs', {
      ...brand,
      userName: me.name,
      otpCode: made.code,
      otpAmount: rupiah(amount),
      ttlMinutes: OTP_TTL_MINUTES,
    });
    const sent = await sendMail({
      to: me.email,
      subject: `Kode OTP penarikan ${rupiah(amount)} — ${brand.brandName}`,
      html,
      text: `Halo ${me.name}, kode OTP penarikan ${rupiah(amount)} Anda: ${made.code} (berlaku ${OTP_TTL_MINUTES} menit). Jangan berikan ke siapa pun.`,
    });
    if (!sent.ok) {
      return res.status(500).json({ ok: false, message: 'Gagal mengirim email OTP. Coba lagi / hubungi admin.' });
    }
    return res.json({ ok: true, message: `Kode OTP dikirim ke ${me.email}.`, ttlMinutes: OTP_TTL_MINUTES, maskedEmail: maskEmail(me.email) });
  } catch (err) {
    console.error('OTP penarikan error:', err);
    return res.status(500).json({ ok: false, message: 'Gagal membuat kode OTP.' });
  }
};

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 1) return '***';
  return s[0] + '***' + s.slice(at);
}

// Ajukan penarikan: saldo ditahan (debit) + baris pengajuan status pending.
exports.userCreate = async (req, res) => {
  const userId = sessionUserId(req);
  if (!userId) return res.redirect('/login');
  const back = '/marketing/penarikan';
  try {
    const amount = wallet.toAmount(req.body.amount);
    const min = await wallet.minWithdraw();
    if (!amount) {
      flash(req, 'error', 'Nominal penarikan tidak valid.');
      return res.redirect(back);
    }
    if (amount < min) {
      flash(req, 'error', `Nominal minimal penarikan ${rupiah(min)}.`);
      return res.redirect(back);
    }

    const me = await get(
      'SELECT id, name, email, bank_name, account_number, nik, ktp_file FROM users WHERE id = ?',
      [userId]
    );
    if (!me.bank_name || !me.account_number) {
      flash(req, 'error', 'Lengkapi nama bank & nomor rekening di Profil dulu sebelum menarik dana.');
      return res.redirect('/marketing/profil');
    }
    // Wajib verifikasi KTP (NIK + foto KTP di Profil) sebelum dana bisa ditarik.
    if (!me.nik || !me.ktp_file) {
      flash(req, 'error', 'Verifikasi KTP dulu di Profil (isi NIK + upload foto KTP) sebelum menarik dana.');
      return res.redirect('/marketing/profil');
    }

    // Wajib OTP yang dikirim ke email (anti-bajak sesi / CSRF).
    const { verifyOtp } = require('../utils/withdrawOtp');
    const checked = await verifyOtp(userId, req.body.otp, amount);
    if (!checked.ok) {
      flash(req, 'error', checked.error);
      return res.redirect(back);
    }

    const summary = await wallet.getWalletSummary(userId);
    if (amount > summary.balance) {
      flash(req, 'error', `Saldo tersedia hanya ${rupiah(summary.balance)} (sebagian mungkin sedang diproses).`);
      return res.redirect(back);
    }

    const conn = await pool.getConnection();
    let withdrawalId = 0;
    try {
      await conn.beginTransaction();
      // Rekening disalin ke baris pengajuan agar target transfer tidak berubah
      // bila mitra mengubah profil setelah mengajukan.
      const [ins] = await conn.query(
        `INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name)
         VALUES (?,?,?,?,?)`,
        [userId, amount, me.bank_name, me.account_number, me.name]
      );
      withdrawalId = ins.insertId;
      await wallet.holdWithdrawal(conn, { userId, amount, withdrawalId });
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    const after = await wallet.getWalletSummary(userId);
    flash(req, 'success', `Pengajuan penarikan ${rupiah(amount)} terkirim. Saldo tersedia sekarang ${rupiah(after.balance)}.`);
    notifyAdmins(
      userId,
      `💸 Pengajuan penarikan ${rupiah(amount)}`,
      `${me.name} mengajukan penarikan ${rupiah(amount)} ke ${me.bank_name} ${me.account_number}.`,
      '/admin/pembayaran'
    );
    mailAdmins(
      `Pengajuan penarikan dana ${rupiah(amount)} menunggu diproses`,
      {
        heading: 'Pengajuan penarikan dana baru',
        intro: `${me.name} (${me.email}) mengajukan penarikan dana.`,
        lines: [
          ['Nominal', rupiah(amount)],
          ['Bank', me.bank_name || '-'],
          ['Rekening', me.account_number || '-'],
          ['Pengajuan', '#' + withdrawalId],
        ],
        actionUrl: appBase(res) + '/admin/pembayaran',
        actionText: 'Proses Pembayaran',
      },
      `Pengajuan penarikan ${rupiah(amount)} dari ${me.name} menunggu diproses di /admin/pembayaran.`
    );
    mailTo(
      me.email,
      `Pengajuan penarikan ${rupiah(amount)} diterima`,
      {
        heading: 'Pengajuan penarikan diterima',
        intro: `Halo ${me.name}, pengajuan penarikan dana Anda sudah kami terima dan masuk antrean pembayaran.`,
        lines: [
          ['Nominal', rupiah(amount)],
          ['Bank', me.bank_name || '-'],
          ['Rekening', me.account_number || '-'],
          ['Status', STATUS_LABEL.pending],
        ],
        actionUrl: appBase(res) + '/marketing/penarikan',
        actionText: 'Lihat Status Penarikan',
      },
      `Pengajuan penarikan ${rupiah(amount)} diterima dan akan diproses admin.`
    );
    res.redirect(back);
  } catch (err) {
    console.error('Ajukan penarikan error:', err);
    flash(req, 'error', `Gagal mengajukan penarikan: ${err.message}`);
    res.redirect(back);
  }
};

// Batalkan pengajuan yang masih menunggu (saldo hold dikembalikan).
exports.userCancel = async (req, res) => {
  const userId = sessionUserId(req);
  if (!userId) return res.redirect('/login');
  const back = '/marketing/penarikan';
  try {
    const id = Number(req.body.id);
    const wd = await get(
      'SELECT id, amount, status FROM withdrawals WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId]
    );
    if (!wd) {
      flash(req, 'error', 'Pengajuan tidak ditemukan.');
      return res.redirect(back);
    }
    if (wd.status !== 'pending') {
      flash(req, 'error', 'Hanya pengajuan yang belum diproses admin yang bisa dibatalkan.');
      return res.redirect(back);
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        "UPDATE withdrawals SET status = 'cancelled', admin_note = 'Dibatalkan oleh pengaju' WHERE id = ? AND status = 'pending'",
        [id]
      );
      await wallet.refundWithdrawal(conn, { userId, amount: wd.amount, withdrawalId: id });
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    const after = await wallet.getWalletSummary(userId);
    flash(req, 'success', `Pengajuan #${id} dibatalkan. Saldo tersedia ${rupiah(after.balance)}.`);
    notifyAdmins(
      userId,
      `↩️ Penarikan #${id} dibatalkan pengaju`,
      `Pengajuan penarikan ${rupiah(wd.amount)} dibatalkan oleh mitra sebelum diproses.`,
      '/admin/pembayaran'
    );
    res.redirect(back);
  } catch (err) {
    console.error('Batal penarikan error:', err);
    flash(req, 'error', 'Gagal membatalkan pengajuan.');
    res.redirect(back);
  }
};

// ---------------------------------------------------------------- ADMIN

function parseFilters(q) {
  const status = ['pending', 'processing', 'paid', 'rejected', 'cancelled'].includes(String(q.status || ''))
    ? String(q.status)
    : 'all';
  const term = String(q.q || '').trim().slice(0, 60);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) ? String(q.from) : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || '')) ? String(q.to) : '';
  const where = [];
  const params = [];
  if (status !== 'all') {
    where.push('w.status = ?');
    params.push(status);
  }
  if (term) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR u.referral_code LIKE ?)');
    params.push('%' + term + '%', '%' + term + '%', '%' + term + '%');
  }
  if (from) {
    where.push('w.requested_at >= ?');
    params.push(from + ' 00:00:00');
  }
  if (to) {
    where.push('w.requested_at <= ?');
    params.push(to + ' 23:59:59');
  }
  return { status, term, from, to, whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// Laporan pembayaran: ringkasan per status + daftar pengajuan.
exports.adminPage = async (req, res) => {
  try {
    const f = parseFilters(req.query);
    let rows = [];
    let filtered = { total: 0, amount: 0, pending: 0, pending_amount: 0, processing: 0, processing_amount: 0, paid: 0, paid_amount: 0, rejected: 0, rejected_amount: 0 };
    let global = { pending: 0, pending_amount: 0, processing: 0, processing_amount: 0, paid: 0, paid_amount: 0 };
    try {
      rows = await query(
        `SELECT w.id, w.user_id, w.amount, w.bank_name, w.account_number, w.account_name,
                w.status, w.admin_note, w.reject_reason, w.transfer_ref, w.proof_file,
                w.requested_at, w.processed_at, w.paid_at, w.processed_by,
                u.name, u.email, u.whatsapp, u.referral_code, u.is_head, u.is_coordinator,
                a.name AS processed_by_name
         FROM withdrawals w
         JOIN users u ON u.id = w.user_id
         LEFT JOIN users a ON a.id = w.processed_by
         ${f.whereSql}
         ORDER BY FIELD(w.status, 'pending', 'processing', 'paid', 'rejected', 'cancelled'), w.id DESC
         LIMIT 300`,
        f.params
      );
      const agg = (await query(
        `SELECT COUNT(*) total,
                COALESCE(SUM(w.amount),0) amount,
                COALESCE(SUM(CASE WHEN w.status = 'pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN w.status = 'pending' THEN w.amount ELSE 0 END),0) pending_amount,
                COALESCE(SUM(CASE WHEN w.status = 'processing' THEN 1 ELSE 0 END),0) processing,
                COALESCE(SUM(CASE WHEN w.status = 'processing' THEN w.amount ELSE 0 END),0) processing_amount,
                COALESCE(SUM(CASE WHEN w.status = 'paid' THEN 1 ELSE 0 END),0) paid,
                COALESCE(SUM(CASE WHEN w.status = 'paid' THEN w.amount ELSE 0 END),0) paid_amount,
                COALESCE(SUM(CASE WHEN w.status = 'rejected' THEN 1 ELSE 0 END),0) rejected,
                COALESCE(SUM(CASE WHEN w.status = 'rejected' THEN w.amount ELSE 0 END),0) rejected_amount
         FROM withdrawals w JOIN users u ON u.id = w.user_id ${f.whereSql}`,
        f.params
      ))[0];
      filtered = agg;
      global = (await query(
        `SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END),0) pending_amount,
                COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END),0) processing,
                COALESCE(SUM(CASE WHEN status = 'processing' THEN amount ELSE 0 END),0) processing_amount,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END),0) paid,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END),0) paid_amount
         FROM withdrawals`
      ))[0];
    } catch (e) {
      // Tabel belum dimigrasi -> halaman tetap terbuka dengan peringatan.
      console.error('Laporan pembayaran error:', e.message);
    }

    const bankReady = (await query(
      `SELECT COUNT(*) c FROM user_wallets w JOIN users u ON u.id = w.user_id
       WHERE w.balance > 0 AND (u.bank_name IS NULL OR u.bank_name = '' OR u.account_number IS NULL OR u.account_number = '')`
    ))[0].c;

    res.render('admin/pembayaran', {
      title: 'Pembayaran Fee - BSS',
      rows,
      filtered,
      global,
      filters: f,
      statusLabel: STATUS_LABEL,
      bankReady,
      rupiah,
      minWithdraw: await wallet.minWithdraw(),
    });
  } catch (err) {
    console.error('Pembayaran admin page error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
};

// Aksi admin: proses (pending -> processing), bayar (-> paid), tolak (-> rejected).
exports.adminAction = async (req, res) => {
  const back = '/admin/pembayaran';
  const adminId = sessionUserId(req);
  // id/action di luar try agar blok catch bisa menilai apakah aksinya tersimpan.
  let id = 0;
  let action = '';
  try {
    id = Number(req.body.id);
    action = String(req.body.action || '');
    const note = String(req.body.admin_note || '').trim().slice(0, 255);
    const transferRef = String(req.body.transfer_ref || '').trim().slice(0, 100);
    const reason = String(req.body.reject_reason || '').trim().slice(0, 255);
    const proofName = req.file ? '/uploads/' + req.file.filename : '';

    const wd = await get(
      `SELECT w.id, w.user_id, w.amount, w.status, w.proof_file, u.name, u.email
       FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ? LIMIT 1`,
      [id]
    );
    if (!wd) {
      dropProof(req);
      flash(req, 'error', 'Pengajuan tidak ditemukan.');
      return res.redirect(back);
    }
    if (!['process', 'paid', 'reject'].includes(action)) {
      dropProof(req);
      flash(req, 'error', 'Aksi tidak dikenal.');
      return res.redirect(back);
    }

    const open = wd.status === 'pending' || wd.status === 'processing';
    const base = appBase(res);
    let message = '';

    if (action === 'process') {
      if (!open) {
        dropProof(req);
        flash(req, 'error', `Pengajuan #${id} sudah ${STATUS_LABEL[wd.status] || wd.status}.`);
        return res.redirect(back);
      }
      await query(
        `UPDATE withdrawals SET status = 'processing', processed_at = NOW(), processed_by = ?, admin_note = ?
         WHERE id = ?`,
        [adminId, note || null, id]
      );
      message = `Pengajuan #${id} (${rupiah(wd.amount)}) ditandai sedang diproses.`;
      notifyUser(
        wd.user_id,
        `⏳ Penarikan #${id} sedang diproses`,
        `Pengajuan penarikan ${rupiah(wd.amount)} sedang diproses admin${note ? ' — ' + note : ''}.`,
        '/marketing/penarikan'
      );
      mailTo(wd.email, `Penarikan ${rupiah(wd.amount)} sedang diproses`, {
        heading: 'Penarikan sedang diproses',
        intro: `Halo ${wd.name}, pengajuan penarikan dana Anda sedang diproses admin.`,
        lines: [['Pengajuan', '#' + id], ['Nominal', rupiah(wd.amount)], ['Status', STATUS_LABEL.processing], ['Catatan', note || '-']],
        actionUrl: base + '/marketing/penarikan',
        actionText: 'Lihat Status Penarikan',
      }, `Pengajuan penarikan #${id} sedang diproses.`);
    } else if (action === 'paid') {
      if (!open) {
        dropProof(req);
        flash(req, 'error', `Pengajuan #${id} sudah ${STATUS_LABEL[wd.status] || wd.status}.`);
        return res.redirect(back);
      }
      await query(
        `UPDATE withdrawals SET status = 'paid', paid_at = NOW(), processed_at = COALESCE(processed_at, NOW()),
           processed_by = ?, admin_note = ?, transfer_ref = ?,
           proof_file = COALESCE(NULLIF(?, ''), proof_file)
         WHERE id = ?`,
        [adminId, note || null, transferRef || null, proofName, id]
      );
      message = `Penarikan #${id} (${rupiah(wd.amount)}) ditandai sudah dibayarkan.`;
      notifyUser(
        wd.user_id,
        `✅ Penarikan #${id} sudah dibayarkan`,
        `Dana ${rupiah(wd.amount)} sudah dibayarkan${transferRef ? ' (ref: ' + transferRef + ')' : ''}. Cek bukti transfer di halaman penarikan.`,
        '/marketing/penarikan'
      );
      mailTo(wd.email, `Penarikan ${rupiah(wd.amount)} sudah dibayarkan`, {
        heading: 'Penarikan dana sudah dibayarkan',
        intro: `Halo ${wd.name}, dana penarikan Anda sudah kami transfer.`,
        lines: [
          ['Pengajuan', '#' + id],
          ['Nominal', rupiah(wd.amount)],
          ['Status', STATUS_LABEL.paid],
          ['Referensi transfer', transferRef || '-'],
          ['Catatan', note || '-'],
        ],
        actionUrl: base + '/marketing/penarikan',
        actionText: 'Lihat Bukti Transfer',
      }, `Penarikan #${id} (${rupiah(wd.amount)}) sudah dibayarkan.`);
    } else {
      if (!open) {
        dropProof(req);
        flash(req, 'error', `Pengajuan #${id} sudah ${STATUS_LABEL[wd.status] || wd.status}.`);
        return res.redirect(back);
      }
      if (!reason) {
        dropProof(req);
        flash(req, 'error', 'Alasan penolakan wajib diisi.');
        return res.redirect(back);
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(
          `UPDATE withdrawals SET status = 'rejected', reject_reason = ?, admin_note = ?,
             processed_at = NOW(), processed_by = ? WHERE id = ?`,
          [reason, note || null, adminId, id]
        );
        // Saldo hold dikembalikan ke mitra.
        await wallet.refundWithdrawal(conn, {
          userId: wd.user_id, amount: wd.amount, withdrawalId: id,
          note: `Pengembalian saldo penarikan #${id} (ditolak admin)`,
        });
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      const after = await wallet.getWalletSummary(wd.user_id);
      message = `Pengajuan #${id} ditolak. Saldo ${rupiah(wd.amount)} dikembalikan ke mitra.`;
      notifyUser(
        wd.user_id,
        `❌ Penarikan #${id} ditolak`,
        `Pengajuan penarikan ${rupiah(wd.amount)} ditolak: ${reason}. Saldo tersedia Anda ${rupiah(after.balance)}.`,
        '/marketing/penarikan'
      );
      mailTo(wd.email, `Penarikan ${rupiah(wd.amount)} ditolak`, {
        heading: 'Penarikan dana ditolak',
        intro: `Halo ${wd.name}, pengajuan penarikan Anda belum dapat diproses.`,
        lines: [
          ['Pengajuan', '#' + id],
          ['Nominal', rupiah(wd.amount)],
          ['Status', STATUS_LABEL.rejected],
          ['Alasan', reason],
          ['Saldo tersedia', rupiah(after.balance)],
        ],
        actionUrl: base + '/marketing/penarikan',
        actionText: 'Ajukan Ulang',
      }, `Pengajuan penarikan #${id} ditolak: ${reason}.`);
    }

    flash(req, 'success', message);
    res.redirect(back);
  } catch (err) {
    console.error('Aksi pembayaran error:', err);
    // Bukti transfer yang gagal dipakai jangan menumpuk di folder uploads:
    // buang hanya bila transisi statusnya tidak tersimpan.
    const expected = action === 'process' ? 'processing' : (action === 'paid' ? 'paid' : (action === 'reject' ? 'rejected' : ''));
    let saved = null;
    try {
      saved = id && expected ? await get('SELECT status FROM withdrawals WHERE id = ?', [id]) : null;
    } catch (e) { saved = null; }
    if (!saved || !expected || saved.status !== expected) dropProof(req);
    flash(req, 'error', `Gagal memproses: ${err.message}`);
    res.redirect(back);
  }
};

// Laporan CSV (dibuka di Excel) mengikuti filter yang aktif di halaman.
exports.adminExportCsv = async (req, res) => {
  try {
    const f = parseFilters(req.query);
    let rows = [];
    try {
      rows = await query(
        `SELECT w.id, w.requested_at, u.name, u.email, u.whatsapp, u.referral_code,
                w.bank_name, w.account_number, w.account_name, w.amount, w.status,
                w.admin_note, w.reject_reason, w.transfer_ref, w.paid_at
         FROM withdrawals w JOIN users u ON u.id = w.user_id
         ${f.whereSql}
         ORDER BY w.id DESC`,
        f.params
      );
    } catch (e) {
      console.error('Export pembayaran error:', e.message);
    }

    // Anti-CSV-injection: sel yang diawali = + - @ dinetralkan.
    const cell = (v) => {
      const s = String(v == null ? '' : v);
      return '"' + (/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
    };
    const head = ['ID', 'Tanggal Pengajuan', 'Nama', 'Email', 'WhatsApp', 'Kode Referral',
      'Bank', 'No. Rekening', 'Atas Nama', 'Nominal', 'Status', 'Catatan Admin',
      'Alasan Tolak', 'Ref Transfer', 'Tanggal Dibayar'];
    const lines = [head.map(cell).join(';')];
    rows.forEach((r) => {
      lines.push([
        r.id, r.requested_at ? new Date(r.requested_at).toLocaleString('id-ID') : '',
        r.name, r.email, r.whatsapp, r.referral_code, r.bank_name, r.account_number,
        r.account_name, Number(r.amount || 0), STATUS_LABEL[r.status] || r.status,
        r.admin_note, r.reject_reason, r.transfer_ref,
        r.paid_at ? new Date(r.paid_at).toLocaleString('id-ID') : '',
      ].map(cell).join(';'));
    });
    const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="pembayaran-fee-${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Export CSV error:', err);
    res.status(500).send('Gagal membuat laporan.');
  }
};
