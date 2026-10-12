require('dotenv').config();
const path = require('path');
const express = require('express');
const compression = require('compression');
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

// Helper global untuk template (cadangan bila middleware locals terlewat):
// tersedia di SEMUA render EJS tanpa terkecuali.
try {
  app.locals.fileUrl = require('./utils/fileUrl').toBerkas;
} catch (e) {
  app.locals.fileUrl = (p) => p;
}

// Header keamanan. CSP disesuaikan: inline script/style dipakai di views,
// peta memakai tile OSM/Esri + reverse-geocode Nominatim.
// Font di-self-host (public/fonts) sehingga tidak ada koneksi Google Fonts.
app.use(helmet({
  // HSTS hanya di produksi (HTTPS). Di development (http://localhost)
  // header ini tidak boleh dikirim agar browser tidak mengunci hostname
  // localhost ke HTTPS (pin HSTS berlaku per-host, semua port!).
  hsts: isProd ? undefined : false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
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
// OTP penarikan dana (anti spam / sedot email): hanya POST, 10x per 15 menit per IP.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skip: (req) => req.method !== 'POST',
  message: { ok: false, message: 'Terlalu banyak permintaan kode OTP. Coba lagi 15 menit.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use('/marketing/penarikan/otp', otpLimiter);

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
// Pengajuan lahan via API dibatasi seperti form web (anti spam).
const apiSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  skip: (req) => req.method !== 'POST',
  message: { ok: false, message: 'Terlalu banyak pengajuan. Coba lagi nanti.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use('/api/v1/lahan', apiSubmitLimiter);

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

// Kompresi gzip/brotli untuk HTML/CSS/JS (wajib untuk skor PageSpeed mobile).
// Harus dipasang SEBELUM express.static & routes agar aset statis ikut terkompres.
app.use(compression());

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET || 'jap-secret-dev-only',
    resave: false,
    saveUninitialized: false,
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

// Folder uploads TIDAK terekspos:
// - URL /uploads/* selalu dijawab 404 (tidak ada listing, tidak ada bocoran
//   keberadaan berkas), baik anonim maupun login.
// - Satu-satunya akses berkas adalah GET /berkas/<nama> (wajib login + cek
//   kepemilikan, header no-store/noindex) — lihat routes/fileRoutes.js.
// - Template WAJIB memakai helper fileUrl() (res.locals), bukan path mentah.
app.use('/uploads', (req, res) => {
  res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.set('X-Content-Type-Options', 'nosniff');
  return res.status(404).send('Tidak ditemukan.');
});
app.use('/berkas', require('./routes/fileRoutes'));

// Katalog sumber daya agen (spesifikasi ai-catalog / ARD) untuk audit
// "Penjelajahan Agentic" PageSpeed: wajib JSON valid di /.well-known/.
// express.static mengabaikan dotfile, jadi sajikan lewat route eksplisit.
// Salinan yang sama juga tersedia di /ai-catalog.json via static.
app.get('/.well-known/ai-catalog.json', (req, res) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'public', 'ai-catalog.json'));
});

// Aset statis dengan cache lama (30 hari) agar lolos audit PageSpeed
// "Serve static assets with efficient cache policy".
// EJS/HTML tetap dinamis (tidak ter-cache) karena hanya folder public yang di-cache.
// Nama logo upload mengandung timestamp sehingga aman di-cache lama.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '30d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Gambar/font/vendor yang immutable (ada hash/timestamp di nama) boleh 1 tahun.
    if (/\.(png|jpe?g|webp|avif|svg|woff2?|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

app.use(async (req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.user = req.session.user || null;
  res.locals.withMap = false;
  // Helper URL berkas privat: /uploads/x -> /berkas/x (wajib dipakai template).
  try {
    res.locals.fileUrl = require('./utils/fileUrl').toBerkas;
  } catch (e) {
    res.locals.fileUrl = (p) => p;
  }
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
  res.locals.referralCode = req.session.referralCode
    || (req.session.user && req.session.user.referral_code) || '';
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
app.use('/api/v1', apiLimiter, (req, res, next) => {
  // Tulis ulang path /uploads/* di respons JSON menjadi /berkas/* agar
  // aplikasi mobile tidak pernah menerima/menyimpan URL folder uploads.
  const { toBerkas } = require('./utils/fileUrl');
  const origJson = res.json.bind(res);
  const rewrite = (v) => {
    if (typeof v === 'string') return v.indexOf('/uploads/') >= 0 ? v.split('/uploads/').join('/berkas/') : v;
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) v[k] = rewrite(v[k]);
      return v;
    }
    return v;
  };
  res.json = (body) => origJson(rewrite(body));
  // Samakan helper fileUrl untuk pemakaian server-side bila diperlukan.
  res.locals.fileUrl = toBerkas;
  next();
}, require('./routes/apiV1Routes'));

app.use('/', require('./routes/notifRoutes'));
app.use('/', require('./routes/deviceRoutes'));
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