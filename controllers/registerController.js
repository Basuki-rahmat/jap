// Pendaftaran marketing mandiri (publik): wajib kode referral milik marketing aktif.
// Alur: isi form -> verifikasi email (24 jam) -> menunggu persetujuan admin -> aktif.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query, get } = require('../models/db');
const {
  resolveBankName, normNik, normRek, validateMarketingIdentity, normalizePhone62,
} = require('../utils/ownerFields');

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

function appBase(req) {
  const host = req.get('host') || process.env.APP_HOST || 'localhost:3000';
  const envUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return envUrl && !/localhost/.test(envUrl) ? envUrl : `${req.protocol}://${host}`;
}

function blankForm() {
  return {
    name: '', email: '', whatsapp: '', nik: '', bank_name: '',
    bank_name_other: '', account_number: '', ref_code: '',
  };
}

exports.showDaftar = (req, res) => {
  const ref = req.query.ref
    ? String(req.query.ref).slice(0, 20)
    : (req.session.referralCode || '');
  if (req.query.ref) req.session.referralCode = String(req.query.ref).slice(0, 20);
  const form = blankForm();
  if (ref) form.ref_code = ref;
  res.render('public/daftar-marketing', {
    title: 'Daftar Marketing - BSS',
    error: null, form,
  });
};

exports.submitDaftar = async (req, res) => {
  const form = blankForm();
  ['name', 'email', 'whatsapp', 'nik', 'bank_name', 'bank_name_other', 'account_number', 'ref_code'].forEach((k) => {
    form[k] = String((req.body && req.body[k]) || '').slice(0, 150);
  });
  const fail = (msg) => res.status(400).render('public/daftar-marketing', {
    title: 'Daftar Marketing - BSS', error: msg, form,
  });

  try {
    const name = String(req.body.name || '').trim().slice(0, 100);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 100);
    const whatsapp = normalizePhone62(req.body.whatsapp);
    const refCode = String(req.body.ref_code || '').trim().toUpperCase().slice(0, 20);
    const password = String(req.body.password || '');
    const confirm = String(req.body.confirm_password || '');
    const agree = req.body.agree === 'on' || req.body.agree === '1';

    if (!name) return fail('Nama lengkap wajib diisi.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('Alamat email tidak valid.');
    if (!whatsapp || whatsapp.length < 10) return fail('No. WhatsApp wajib diisi dengan benar.');
    const identErr = validateMarketingIdentity(req.body);
    if (identErr) return fail(identErr);
    if (!refCode) return fail('Kode referral wajib diisi. Minta kode dari marketing yang mengajak Anda.');
    if (!password || password.length < 6) return fail('Password minimal 6 karakter.');
    if (password !== confirm) return fail('Konfirmasi password tidak sama.');
    if (!agree) return fail('Anda harus menyetujui syarat & ketentuan pendaftaran.');

    // Kode referral: harus milik marketing AKTIF (tidak dikunci). Berlaku untuk
    // marketing biasa maupun head — downline menempel di bawah pemilik kode.
    const refOwner = await get(
      `SELECT id, name, referral_code FROM users
        WHERE referral_code = ? AND role = 'marketing' AND (is_locked = 0 OR is_locked IS NULL) LIMIT 1`,
      [refCode]
    );
    if (!refOwner) {
      return fail(`Kode referral "${refCode}" tidak valid / pemiliknya tidak aktif. Pastikan kode benar.`);
    }

    if (await get('SELECT id FROM users WHERE email = ?', [email])) {
      return fail(`Email ${email} sudah terdaftar. Silakan login atau gunakan email lain.`);
    }
    if (await get('SELECT id FROM users WHERE whatsapp = ?', [whatsapp])) {
      return fail('No. WhatsApp sudah dipakai akun lain (tidak bisa double).');
    }
    const bankName = resolveBankName(req.body);
    const accountNumber = normRek(req.body.account_number);
    const nik = normNik(req.body.nik);
    if (await get('SELECT id FROM users WHERE nik = ?', [nik])) {
      return fail('NIK / No. KTP sudah terdaftar (tidak bisa double).');
    }

    const referralCode = await generateReferralCode();
    const hash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString('hex');
    const base = appBase(req);

    let newId;
    try {
      const r = await query(
        `INSERT INTO users (name, email, whatsapp, nik, bank_name, account_number, password, role,
          referral_code, parent_id, is_head, downline_quota, is_locked,
          mkt_status, email_verify_token, email_verify_expires)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,0,1,'pending_verification',?,DATE_ADD(NOW(), INTERVAL 1 DAY))`,
        [name, email, whatsapp, nik, bankName, accountNumber, hash, 'marketing',
          referralCode, refOwner.id, token]
      );
      newId = r.insertId;
    } catch (err) {
      if (err.code === 'ER_BAD_FIELD_ERROR') {
        console.error('Daftar marketing: kolom baru belum ada — jalankan node config/upgradeDb.js');
        return fail('Sistem pendaftaran sedang disiapkan. Coba lagi nanti / hubungi admin.');
      }
      if (err.code === 'ER_DUP_ENTRY') {
        return fail('Gagal: Email / No. WA / NIK sudah dipakai akun lain (tidak bisa double).');
      }
      throw err;
    }

    // Email verifikasi (fire-and-forget agar tidak menahan response).
    try {
      const { emailBrand, renderEmail, sendMailAsync } = require('../utils/mailer');
      const brand = await emailBrand();
      const verifyUrl = `${base}/verifikasi-email/${token}`;
      const html = await renderEmail('verify.ejs', {
        ...brand, userName: name, verifyUrl,
        refCode: refOwner.referral_code, refOwner: refOwner.name,
      });
      sendMailAsync({
        to: email,
        subject: `Verifikasi email pendaftaran Marketing ${brand.brandName}`,
        html,
        text: `Halo ${name}, verifikasi email pendaftaran Marketing Anda: ${verifyUrl} (berlaku 24 jam).`,
      });
    } catch (e) {
      console.error('Daftar marketing: gagal menyiapkan email verifikasi:', e.message);
    }

    // Notifikasi ringan ke admin (in-app) — ada pendaftar baru menunggu verifikasi.
    try {
      const { notify } = require('../utils/notify');
      notify({
        audience: 'admins',
        title: `📝 Pendaftar marketing baru: ${name.slice(0, 40)}`,
        body: `${email} • ref ${refOwner.referral_code} • menunggu verifikasi email.`,
        link: '/admin/marketing',
      }).catch(() => {});
    } catch (e) {}

    res.render('public/daftar-sukses', {
      title: 'Pendaftaran Terkirim - BSS', email, refCode: refOwner.referral_code,
    });
  } catch (err) {
    console.error('Submit daftar marketing error:', err);
    return fail('Terjadi kesalahan server. Coba lagi nanti.');
  }
};

// Klik link verifikasi email (24 jam) -> status pending_approval + autoresponder.
exports.verifyEmail = async (req, res) => {
  const render = (state, data) => res.render('public/verifikasi-email', {
    title: 'Verifikasi Email - BSS', state, ...(data || {}),
  });
  try {
    const token = String(req.params.token || '').slice(0, 64);
    if (!token) return render('invalid');
    const user = await get(
      `SELECT u.id, u.name, u.email, u.whatsapp, u.mkt_status, u.email_verify_expires,
              p.name AS ref_name, p.referral_code AS ref_code
       FROM users u LEFT JOIN users p ON p.id = u.parent_id
       WHERE u.email_verify_token = ? AND u.role = 'marketing' LIMIT 1`,
      [token]
    );
    if (!user) return render('invalid');
    if (user.mkt_status === 'active') return render('already-active', { name: user.name });
    if (user.mkt_status === 'pending_approval') return render('already', { name: user.name });
    if (!user.email_verify_expires || new Date(user.email_verify_expires) < new Date()) {
      return render('expired', { email: user.email });
    }

    await query(
      `UPDATE users SET mkt_status = 'pending_approval', email_verify_token = NULL,
        email_verify_expires = NULL WHERE id = ?`,
      [user.id]
    );

    const base = appBase(req);
    try {
      const { emailBrand, renderEmail, sendMailAsync } = require('../utils/mailer');
      const brand = await emailBrand();
      const html = await renderEmail('pending.ejs', {
        ...brand,
        userName: user.name, userEmail: user.email, userWa: user.whatsapp,
        refCode: user.ref_code || '-', refOwner: user.ref_name || '-',
        panduanUrl: `${base}/panduan`,
      });
      sendMailAsync({
        to: user.email,
        subject: `Pendaftaran diterima — menunggu persetujuan admin ${brand.brandName}`,
        html,
        text: `Halo ${user.name}, email terverifikasi. Pendaftaran Anda menunggu persetujuan admin.`,
      });
    } catch (e) {
      console.error('Verify email: gagal menyiapkan autoresponder:', e.message);
    }

    try {
      const { notify } = require('../utils/notify');
      notify({
        audience: 'admins',
        userIds: [],
        title: `✅ Email terverifikasi: ${String(user.name).slice(0, 40)}`,
        body: `${user.email} menunggu persetujuan admin. Ref: ${user.ref_code || '-'}.`,
        link: '/admin/marketing',
      }).catch(() => {});
      if (user.ref_code) {
        const owner = await get('SELECT id FROM users WHERE referral_code = ? LIMIT 1', [user.ref_code]);
        if (owner) {
          notify({
            userIds: [owner.id],
            title: `🎉 Calon downline terverifikasi: ${String(user.name).slice(0, 40)}`,
            body: 'Menunggu persetujuan admin. Anda akan dikabari saat akunnya aktif.',
          }).catch(() => {});
        }
      }
    } catch (e) {}

    return render('ok', { name: user.name, email: user.email });
  } catch (err) {
    console.error('Verify email error:', err);
    return render('invalid');
  }
};

// Kirim ulang link verifikasi.
// Jujur sesuai status akun: belum verifikasi -> kirim baru; sudah verifikasi ->
// arahkan menunggu admin; sudah aktif -> arahkan login; tak dikenal -> pesan generik.
exports.resendVerification = async (req, res) => {
  const done = (state, data) => res.render('public/verifikasi-email', {
    title: 'Verifikasi Email - BSS', state, ...(data || {}),
  });
  try {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 100);
    if (!email) return done('resent');
    const user = await get(
      `SELECT id, name, mkt_status FROM users WHERE email = ? AND role = 'marketing' LIMIT 1`,
      [email]
    );
    if (!user) return done('resent'); // anti-enumerasi: email tak dikenal
    if (user.mkt_status === 'active') return done('already-active', { name: user.name });
    if (user.mkt_status === 'pending_approval') return done('already', { name: user.name });
    if (user.mkt_status !== 'pending_verification') return done('resent');
    {
      const token = crypto.randomBytes(32).toString('hex');
      await query(
        `UPDATE users SET email_verify_token = ?, email_verify_expires = DATE_ADD(NOW(), INTERVAL 1 DAY)
         WHERE id = ?`,
        [token, user.id]
      );
      try {
        const { emailBrand, renderEmail, sendMailAsync } = require('../utils/mailer');
        const brand = await emailBrand();
        const ref = await get(
          `SELECT p.referral_code, p.name FROM users u LEFT JOIN users p ON p.id = u.parent_id WHERE u.id = ? LIMIT 1`,
          [user.id]
        );
        const html = await renderEmail('verify.ejs', {
          ...brand, userName: user.name,
          verifyUrl: `${appBase(req)}/verifikasi-email/${token}`,
          refCode: (ref && ref.referral_code) || '-', refOwner: (ref && ref.name) || '-',
        });
        sendMailAsync({
          to: email,
          subject: `Verifikasi email pendaftaran Marketing ${brand.brandName} (kirim ulang)`,
          html,
          text: `Tautan verifikasi baru Anda berlaku 24 jam.`,
        });
      } catch (e) {
        console.error('Resend verification: gagal menyiapkan email:', e.message);
      }
    }
  } catch (err) {
    console.error('Resend verification error:', err);
  }
  return done('resent');
};
