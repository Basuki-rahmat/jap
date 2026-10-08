// Lupa password via email: link token sekali pakai, kedaluwarsa 1 jam.
// Berlaku untuk semua peran (superadmin & marketing). Anti-enumerasi:
// response selalu generik agar tak bisa menebak email terdaftar.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query, get } = require('../models/db');

function appBase(req) {
  const host = req.get('host') || process.env.APP_HOST || 'localhost:3000';
  const envUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return envUrl && !/localhost/.test(envUrl) ? envUrl : `${req.protocol}://${host}`;
}

exports.showForgot = (req, res) => {
  if (req.session.user) {
    const role = req.session.user.role;
    return res.redirect(role === 'superadmin' ? '/admin' : '/marketing');
  }
  res.render('public/lupa-password', { title: 'Lupa Password - BSS', error: null, sent: false });
};

exports.sendLink = async (req, res) => {
  const renderSent = () => res.render('public/lupa-password', {
    title: 'Lupa Password - BSS', error: null, sent: true,
  });
  try {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 100);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).render('public/lupa-password', {
        title: 'Lupa Password - BSS', error: 'Masukkan alamat email yang valid.', sent: false,
      });
    }
    const user = await get('SELECT id, name, email FROM users WHERE email = ? LIMIT 1', [email]);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      try {
        await query(
          'UPDATE users SET reset_token = ?, reset_expires = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
          [token, user.id]
        );
      } catch (err) {
        if (err.code === 'ER_BAD_FIELD_ERROR') {
          console.error('Lupa password: kolom reset_token belum ada — jalankan node config/upgradeDb.js');
          return renderSent();
        }
        throw err;
      }
      const base = appBase(req);
      try {
        const { emailBrand, renderEmail, sendMailAsync } = require('../utils/mailer');
        const brand = await emailBrand();
        const html = await renderEmail('reset-password.ejs', {
          ...brand,
          userName: user.name, userEmail: user.email,
          resetUrl: `${base}/reset-password/${token}`,
        });
        sendMailAsync({
          to: user.email,
          subject: `Reset password akun ${brand.brandName}`,
          html,
          text: `Halo ${user.name}, buat password baru Anda di: ${base}/reset-password/${token} (berlaku 1 jam).`,
        });
      } catch (e) {
        console.error('Lupa password: gagal menyiapkan email reset:', e.message);
      }
    }
    // Selalu respons sama (ada / tidak ada akun) — anti enumerasi email.
    return renderSent();
  } catch (err) {
    console.error('Lupa password error:', err);
    return renderSent();
  }
};

async function findByToken(token) {
  const t = String(token || '').slice(0, 64);
  if (!t) return null;
  try {
    return await get('SELECT id, name, email, reset_expires FROM users WHERE reset_token = ? LIMIT 1', [t]);
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return null;
    throw err;
  }
}

exports.showReset = async (req, res) => {
  try {
    const user = await findByToken(req.params.token);
    if (!user || !user.reset_expires || new Date(user.reset_expires) < new Date()) {
      return res.status(400).render('public/reset-password', {
        title: 'Reset Password - BSS', state: 'invalid', error: null,
      });
    }
    res.render('public/reset-password', {
      title: 'Reset Password - BSS', state: 'form', error: null, name: user.name,
    });
  } catch (err) {
    console.error('Show reset error:', err);
    res.status(500).render('public/reset-password', {
      title: 'Reset Password - BSS', state: 'invalid', error: null,
    });
  }
};

exports.doReset = async (req, res) => {
  const invalid = () => res.status(400).render('public/reset-password', {
    title: 'Reset Password - BSS', state: 'invalid', error: null,
  });
  try {
    const user = await findByToken(req.params.token);
    if (!user || !user.reset_expires || new Date(user.reset_expires) < new Date()) {
      return invalid();
    }
    const p1 = String(req.body.password || '');
    const p2 = String(req.body.confirm_password || '');
    if (!p1 || p1.length < 6) {
      return res.status(400).render('public/reset-password', {
        title: 'Reset Password - BSS', state: 'form', name: user.name,
        error: 'Password baru minimal 6 karakter.',
      });
    }
    if (p1 !== p2) {
      return res.status(400).render('public/reset-password', {
        title: 'Reset Password - BSS', state: 'form', name: user.name,
        error: 'Konfirmasi password tidak sama.',
      });
    }
    await query('UPDATE users SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?', [
      await bcrypt.hash(p1, 10), user.id,
    ]);

    const base = appBase(req);
    try {
      const { emailBrand, renderEmail, sendMailAsync } = require('../utils/mailer');
      const brand = await emailBrand();
      const changedAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
      const html = await renderEmail('password-changed.ejs', {
        ...brand, userName: user.name, userEmail: user.email, changedAt,
        loginUrl: `${base}/login`,
      });
      sendMailAsync({
        to: user.email,
        subject: `Password akun ${brand.brandName} berhasil diganti`,
        html,
        text: `Halo ${user.name}, password akun Anda baru saja diganti. Bukan Anda? Segera hubungi admin.`,
      });
    } catch (e) {
      console.error('Reset password: gagal menyiapkan email konfirmasi:', e.message);
    }

    res.render('public/reset-password', {
      title: 'Reset Password - BSS', state: 'done', error: null,
    });
  } catch (err) {
    console.error('Do reset error:', err);
    return invalid();
  }
};
