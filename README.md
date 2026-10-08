# JAP — Sewa Lahan BSS × V-Green

Platform sewa lahan + referral marketing: pemilik lahan mengajukan lahannya untuk
Battery Swap Station, marketing mendaftar lewat kode referral berjenjang
(Koordinator → Head → Marketing), admin memverifikasi dan mengelola semuanya
dari panel dasbor.

Alur pendaftaran marketing: isi form → verifikasi email (24 jam) →
menunggu persetujuan admin → akun aktif + email sambutan otomatis.

## Fitur utama

- **Publik:** beranda, formulir pengajuan lahan (`/ajukan?ref=...`), pendaftaran
  marketing (`/daftar-marketing`), verifikasi email, lacak pengajuan, struktur tim.
- **Marketing:** dasbor, jaringan downline, ID card digital, surat tugas,
  profil + KTP, proposal PDF, SPPL.
- **Admin (superadmin):** persetujuan pendaftar (setujui/tolak + email otomatis),
  manajemen marketing/head/koordinator, persetujuan lahan, notifikasi in-app,
  pengaturan perusahaan, **diagnostik email** (`/admin/mail-log`).
- **Email transaksional (SMTP):** verifikasi, autoresponder, sambutan aktif,
  penolakan, reset password — fire-and-forget agar tidak menahan response.

## Teknologi

Node.js ≥ 18 (produksi: 24.x) · Express 5 · EJS · MySQL (`mysql2`) ·
`nodemailer@10` (butuh Node ≥ 20) · `express-session` · `helmet` ·
`express-rate-limit` · `multer` · `pdfkit` · `qrcode` · `sharp`.

## Persiapan lokal

```bash
npm install
cp .env.example .env   # lalu isi nilai sebenarnya
node config/initDb.js  # buat database + tabel + akun admin awal
npm run dev            # http://localhost:3000 (nodemon)
```

Upgrade skema tanpa hapus data (idempotent, aman diulang):

```bash
node config/upgradeDb.js [nama_database]
```

## Konfigurasi environment

| Variabel | Contoh | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port aplikasi |
| `NODE_ENV` | `production` | `production` di hosting |
| `SESSION_SECRET` | acak min. 32 karakter | Wajib di produksi |
| `DB_HOST/DB_USER/DB_PASSWORD/DB_NAME/DB_PORT` | — | Kredensial MySQL |
| `APP_URL` | `https://knab.co.id` | Tanpa garis miring akhir |
| `SMTP_HOST/SMTP_PORT/SMTP_SECURE` | `mail.knab.co.id/465/true` | SMTP transaksional |
| `SMTP_USER/SMTP_PASS` | `info@knab.co.id` + password | Akun email pengirim |
| `MAIL_FROM` | `Sewa Lahan BSS <info@knab.co.id>` | Harus mengandung `@` |

> `npm start` = `node app.js`. File startup di hosting: `app.js`.

## Struktur proyek

```
app.js                 # entry point + middleware global + error handler
config/                # database.js, initDb.js, upgradeDb.js, upload.js
controllers/           # admin, auth, marketing, register, passwordReset
routes/                # public, auth, admin, marketing, notif
middlewares/           # isAuth, isRole (+ tendang sesi terkunci)
models/db.js           # helper query/get (mysql2 pool)
utils/                 # mailer, settings, companyProfile, notify, proposalPdf, ...
views/                 # EJS: public/, admin/, marketing/, emails/, partials/
public/                # css, js, img, vendor/leaflet, geojson/
logs/mail.log          # log pengiriman email (diabaikan git)
```

## Deploy ke shared hosting (cPanel + Node.js)

1. Upload semua file ke *Application root* (`bss`), **jangan** upload `node_modules`.
2. Pastikan `.env` produksi ada di folder aplikasi.
3. Klik **Run NPM Install**, tunggu selesai (ini yang memasang `nodemailer` dkk).
4. Klik **RESTART**.
5. Buka `/admin/mail-log`: status harus "Terkonfigurasi ✅ Ya".
   Bila muncul banner merah `nodemailer belum terinstall`, ulangi langkah 3–4.
6. Kirim **email tes** dari halaman yang sama sebelum uji alur pendaftar.

## Diagnostik email

Halaman `/admin/mail-log` menampilkan status SMTP, 100 baris terakhir
`logs/mail.log` (format: `waktu | to=... | subjek | hasil`), dan form kirim tes.

- `OK id=...` → terkirim. `SKIP ...` → dilewati (SMTP/modul belum siap).
  `FAIL ...` → penyebab tertera (salah kredensial/host/port).
- Pengiriman dari controller selalu via `sendMailAsync` (fire-and-forget);
  kegagalan email tidak menggagalkan approve/reject — hanya tercatat di log.

## Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| `Cannot find module 'nodemailer'` / 500 di `/admin/mail-log` | `npm install` belum dijalankan di server | Run NPM Install → Restart |
| Email `FAIL` koneksi/timeout | Host/port diblokir atau salah | Cek `SMTP_HOST/PORT/SECURE`; port 465 + `SECURE=true` untuk SSL |
| `MAIL_FROM tidak valid` di log | `MAIL_FROM` tanpa `@` | Perbaiki format `Nama <user@domain>` |
| Rate limit login/pengajuan | Brute-force protection | Tunggu 15–60 menit / cek IP |
| Sesi hilang saat restart | `MemoryStore` bawaan | Wajar untuk 1 instance; multi-instance perlu Redis store |

## Keamanan

- Jangan commit `.env`, `.env.production`, dump SQL, atau arsip zip berisi
  kredensial — semuanya sudah dikecualikan di `.gitignore`.
- Ganti password default (`admin123`, `jap12345`) setelah login pertama.
- Cookie `secure` aktif di produksi — akses wajib HTTPS.
