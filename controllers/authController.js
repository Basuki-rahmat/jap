const bcrypt = require('bcryptjs');
const { get } = require('../models/db');

function redirectDashboard(res, role) {
  return res.redirect(role === 'superadmin' ? '/admin' : '/marketing');
}

// Judul tab login mengikuti Pengaturan (nama usaha singkat -> perusahaan).
async function loginTitle() {
  try {
    const { getBrand } = require('../utils/companyProfile');
    return 'Login - ' + (await getBrand()).name;
  } catch (e) {
    return 'Login - JAP';
  }
}

exports.showLogin = async (req, res) => {
  if (req.session.user) {
    return redirectDashboard(res, req.session.user.role);
  }
  const err = req.query.locked
    ? 'Akun Anda dikunci oleh admin (kebijakan perusahaan). Hubungi admin untuk informasi lebih lanjut.'
    : undefined;
  res.render('auth/login', { title: await loginTitle(), ...(err ? { error: err } : {}) });
};

exports.login = async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res
        .status(400)
        .render('auth/login', { title: await loginTitle(), error: 'Email dan password wajib diisi.' });
    }

    const user = await get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res
        .status(401)
        .render('auth/login', { title: await loginTitle(), error: 'Email atau password salah.' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res
        .status(401)
        .render('auth/login', { title: await loginTitle(), error: 'Email atau password salah.' });
    }

    if (user.is_locked && Number(user.is_locked) === 1) {
      // Pendaftar marketing yang belum selesai alur: pesan ramah sesuai tahap.
      if (user.role === 'marketing' && user.mkt_status === 'pending_verification') {
        return res
          .status(403)
          .render('auth/login', { title: await loginTitle(), error: 'Email Anda belum diverifikasi. Cek inbox (termasuk spam) lalu klik link verifikasi. Tautan kedaluwarsa? Daftar ulang / hubungi admin.' });
      }
      if (user.role === 'marketing' && user.mkt_status === 'pending_approval') {
        return res
          .status(403)
          .render('auth/login', { title: await loginTitle(), error: 'Pendaftaran Anda menunggu persetujuan admin (biasanya 1x24 jam kerja). Anda akan dikabari via email.' });
      }
      return res
        .status(403)
        .render('auth/login', { title: await loginTitle(), error: 'Akun dikunci oleh admin (kebijakan perusahaan). Hubungi admin untuk informasi lebih lanjut.' });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      referral_code: user.referral_code,
      parent_id: user.parent_id,
      is_head: Number(user.is_head || 0),
      is_coordinator: Number(user.is_coordinator || 0),
    };

    redirectDashboard(res, user.role);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).render('auth/login', { title: await loginTitle(), error: 'Terjadi kesalahan server.' });
  }
};

exports.logout = (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
};