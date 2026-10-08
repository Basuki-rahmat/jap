require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const publicRoutes = require('./routes/publicRoutes');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const marketingRoutes = require('./routes/marketingRoutes');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

const SESSION_SECRET = process.env.SESSION_SECRET || '';
if (isProd && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
  console.error('FATAL: SESSION_SECRET wajib diisi string acak min. 32 karakter di mode produksi.');
  process.exit(1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

// Header keamanan. CSP disesuaikan: inline script/style dipakai di views,
// peta memakai tile OSM/Esri + reverse-geocode Nominatim, font dari Google.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.basemaps.cartocdn.com', 'https://server.arcgisonline.com'],
      connectSrc: ["'self'", 'https://nominatim.openstreetmap.org'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Anti brute-force & spam (berbasis IP; di belakang 1 proxy terpercaya)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skip: (req) => req.method !== 'POST',
  message: 'Terlalu banyak percobaan login. Coba lagi 15 menit.',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  skip: (req) => req.method !== 'POST',
  message: 'Terlalu banyak pengajuan. Coba lagi nanti.',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use('/login', loginLimiter);
app.use('/submit-lahan', submitLimiter);

// API mobile (/api/v1, auth Bearer — tanpa cookie):
// limiter longgar per IP (HP di NAT operator berbagi IP) + ketat khusus auth.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: { ok: false, message: 'Terlalu banyak permintaan API. Coba lagi nanti.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const apiAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skip: (req) => req.method !== 'POST',
  message: { ok: false, message: 'Terlalu banyak percobaan login. Coba lagi 15 menit.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use('/api/v1/auth/login', apiAuthLimiter);
app.use('/api/v1/auth/refresh', apiAuthLimiter);

// Cek kesehatan untuk monitor/uptime (tanpa auth)
app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Favicon ber-box: rakit otomatis dari logo Pengaturan (putih + sudut membulat).
// Browser merender favicon apa adanya, jadi box digambar ke dalam file PNG-nya.
app.get('/favicon.ico', async (req, res) => {
  const fallback = path.join(__dirname, 'public', 'img', 'logo.png');
  try {
    const { getBrand } = require('./utils/companyProfile');
    const { ensureBoxedFavicon } = require('./utils/brandFavicon');
    const brand = await getBrand();
    const boxed = await ensureBoxedFavicon(brand.logo);
    if (boxed) {
      return res.sendFile(path.join(__dirname, 'public', boxed.replace(/^\//, '')), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      });
    }
  } catch (e) {}
  res.sendFile(fallback);
});

// Respon super-ringan untuk crawler media sosial (Facebook/WhatsApp/Telegram/dll).
// /ajukan?ref=... tidak ter-cache (query string selalu cache-miss) sehingga tiap scrape
// menghantam Node + membuat session → mudah kena throttle 429 di shared hosting.
// Bot hanya butuh tag OG, jadi jawab langsung HTML kecil tanpa session/DB/EJS.
// (Browser asli diteruskan ke route normal via next().)
const CRAWLER_RE = /facebookexternalhit|facebot|whatsapp|twitterbot|telegrambot|linkedinbot|slackbot|discordbot|embedly|quora|pinterest/i;
app.get('/ajukan', (req, res, next) => {
  const ua = req.get('user-agent') || '';
  if (!CRAWLER_RE.test(ua)) return next();
  const host = req.get('host') || process.env.APP_HOST || 'localhost:3000';
  const envUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const base = envUrl && !/localhost/.test(envUrl) ? envUrl : req.protocol + '://' + host;
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(
    '<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8" />' +
    '<title>Ajukan Lahan - BSS</title>' +
    '<meta name="description" content="Sewa lahan kecil Anda untuk Battery Swap Station — penghasilan tahunan untuk pemilik lahan." />' +
    '<meta property="og:type" content="website" />' +
    '<meta property="og:title" content="Ajukan Lahan - BSS" />' +
    '<meta property="og:description" content="Sewa lahan kecil Anda untuk Battery Swap Station — penghasilan tahunan untuk pemilik lahan." />' +
    '<meta property="og:image" content="' + base + '/img/og-cover.jpg" />' +
    '<meta property="og:image:width" content="1200" />' +
    '<meta property="og:image:height" content="630" />' +
    '<meta property="og:image:type" content="image/jpeg" />' +
    '<meta property="og:url" content="' + base + '/ajukan" />' +
    '<meta property="og:site_name" content="Sewa Lahan BSS" />' +
    '<meta name="twitter:card" content="summary_large_image" />' +
    '<meta name="twitter:image" content="' + base + '/img/og-cover.jpg" />' +
    '</head><body><a href="' + base + '/ajukan">Formulir Pengajuan Lahan BSS</a></body></html>'
  );
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET || 'jap-secret-dev-only',
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

if (isProd) {
  console.warn('Catatan produksi: session memakai MemoryStore (bawaan). Cocok untuk 1 instance; ' +
    'sesi hilang saat restart dan tidak berbagi antar instance. Untuk multi-instance gunakan Redis store.');
}

// Proteksi file upload: marketing hanya boleh membuka berkas miliknya sendiri.
// (Tanpa ini, URL /uploads/* bisa ditebak dan dibuka siapa pun.)
const { query: dbQuery } = require('./models/db');
const FILE_COLS = ['ktp_file', 'photo_1_file', 'photo_2_file', 'photo_3_file', 'photo_spot_file', 'photo_right_file', 'photo_left_file', 'photo_selfie_file', 'photo_maps_file', 'legal_doc_file', 'family_doc_file', 'sewa_doc_file', 'support_doc_file', 'sppl_file'];
app.use('/uploads', async (req, res, next) => {
  try {
    const file = `/uploads${req.path}`;
    // Publik: foto profil marketing (avatar di /struktur) boleh dibuka tanpa login.
    // KTP & seluruh berkas lahan tetap wajib login + cek kepemilikan.
    try {
      const pub = await dbQuery('SELECT id FROM users WHERE photo_file = ? LIMIT 1', [file]);
      if (pub.length) return next();
    } catch (e) {}
    const user = req.session.user;
    if (!user) return res.status(401).send('Login dahulu untuk membuka berkas.');
    if (user.role === 'superadmin') return next();
    const cond = FILE_COLS.map((c) => `${c} = ?`).join(' OR ');
    const rows = await dbQuery(
      `SELECT id FROM lands WHERE marketing_id = ? AND (${cond}) LIMIT 1`,
      [user.id, ...FILE_COLS.map(() => file)]
    );
    if (rows.length) return next();
    // Head Marketing: boleh membuka berkas referral sendiri + jaringan downline
    // (semua level) agar bisa memeriksa sebelum meminta perbaikan.
    if (user.role === 'marketing') {
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
          const allowed = new Set([Number(user.id)]);
          const stack = (byParent[user.id] || []).slice();
          let guard = 0;
          while (stack.length && guard < 5000) {
            guard += 1;
            const did = stack.pop();
            if (allowed.has(Number(did))) continue;
            allowed.add(Number(did));
            (byParent[did] || []).forEach((k) => stack.push(k));
          }
          if (allowed.size > 1) {
            const ids = Array.from(allowed).filter((v) => v !== Number(user.id));
            if (ids.length) {
              const ph = ids.map(() => '?').join(',');
              const netRows = await dbQuery(
                `SELECT id FROM lands WHERE marketing_id IN (${ph}) AND (${cond}) LIMIT 1`,
                [...ids, ...FILE_COLS.map(() => file)]
              );
              if (netRows.length) return next();
            }
          }
        }
      } catch (e) {}
    }
    // Foto diri & KTP milik sendiri (profil marketing mandiri)
    const own = await dbQuery(
      'SELECT id FROM users WHERE id = ? AND (photo_file = ? OR ktp_file = ?) LIMIT 1',
      [user.id, file, file]
    );
    if (!own.length) return res.status(403).send('Akses ditolak: bukan berkas milik Anda.');
    return next();
  } catch (err) {
    return next(err);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use(async (req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.user = req.session.user || null;
  res.locals.withMap = false;
  // Brand global (logo + nama dari Pengaturan) untuk navbar/footer/favicon.
  try {
    const { getBrand } = require('./utils/companyProfile');
    const brand = await getBrand();
    res.locals.brandName = brand.name;
    res.locals.brandFullName = brand.full;
    res.locals.brandLogo = brand.logo;
  } catch (e) {
    res.locals.brandName = 'BSS';
    res.locals.brandFullName = 'BSS';
    res.locals.brandLogo = '/img/logo.png';
  }
  // Simpan ?ref= ke session agar tidak hilang saat klik Beranda / Panduan
  if (req.query && req.query.ref) {
    req.session.referralCode = String(req.query.ref).slice(0, 20);
  }
  res.locals.referralCode = req.session.referralCode || '';
  next();
});

app.use((req, res, next) => {
  const host = req.get('host') || process.env.APP_HOST || 'localhost:3000';
  const detected = req.protocol + '://' + host;
  const envUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const scheme = envUrl && !/localhost/.test(envUrl) ? envUrl : detected;
  res.locals.APP_URL = scheme;
  res.locals.APP_HOST = host;
  next();
});

app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.use('/', publicRoutes);
app.use('/', authRoutes);

// API JSON v1 untuk aplikasi mobile: CORS terbuka (*) karena auth memakai
// header Authorization (tanpa cookie), preflight dijawab langsung.
// WAJIB di-mount SEBELUM router bercakupan isAuth blanket (notif/admin/
// marketing) agar request tanpa sesi mendapat 401 JSON, bukan redirect /login.
app.use('/api/v1', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api/v1', apiLimiter, require('./routes/apiV1Routes'));

app.use('/', require('./routes/notifRoutes'));
app.use('/admin', adminRoutes);
app.use('/marketing', marketingRoutes);

app.use((req, res) => {
  res.status(404).render('public/404', { title: 'Halaman Tidak Ditemukan' });
});

// Penanganan error global: catat stack lengkap agar penyebab 500 terlacak di log hosting,
// lalu jawab aman tanpa membocorkan detail internal ke browser.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(`ERROR 500 ${req.method} ${req.originalUrl || req.url}:`, (err && err.stack) || err);
  if (res.headersSent) return next(err);
  res.status(500).send(`Terjadi kesalahan server (${req.path}): ` + ((err && err.message) || 'unknown'));
});

app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});