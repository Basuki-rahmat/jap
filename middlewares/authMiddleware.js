const { get } = require('../models/db');

async function isAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  // Penegakan kunci akun seketika: sesi aktif ikut ditendang saat admin mengunci.
  // Gagal baca DB = fail-open (tetap lanjut) agar gangguan DB tak mengunci semua orang.
  try {
    const row = await get('SELECT is_locked FROM users WHERE id = ?', [req.session.user.id]);
    if (row && Number(row.is_locked) === 1) {
      return req.session.destroy(() => res.redirect('/login?locked=1'));
    }
  } catch (e) {
    console.error('isAuth lock check error:', e.message);
  }
  return next();
}

function isRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('public/404', { title: 'Akses Ditolak' });
    }
    return next();
  };
}

module.exports = { isAuth, isRole };