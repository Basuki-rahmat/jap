// Pengiriman email transaksional (pendaftaran marketing dkk.) via SMTP.
// Konfigurasi lewat .env: SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / MAIL_FROM.
// Bila SMTP belum dikonfigurasi, pengiriman dilewati dengan log (tidak menggagalkan alur).
// Selalu panggil sendMailAsync (fire-and-forget) dari controller agar response tak tertahan.
// nodemailer WAJIB ada di dependencies, tapi di hosting kadang node_modules tidak
// ikut ter-upload / npm install belum dijalankan ulang -> require melempar dan
// SEMUA halaman yang menyentuh mailer (termasuk /admin/mail-log) ikut 500.
// Bungkus require agar halaman diagnostik tetap terbuka dengan peringatan jelas.
let nodemailer = null;
let nodemailerErr = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailerErr = e;
  console.error('[mailer] Modul "nodemailer" tidak ditemukan. Jalankan "npm install" di server lalu restart. Detail:', e && e.message);
}
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

function isMailerAvailable() {
  return Boolean(nodemailer);
}

function mailerInstallHint() {
  return 'Modul "nodemailer" belum terinstall di server. Jalankan "npm install" di folder aplikasi lalu restart.';
}

let transporter = null;

// Log pengiriman ke logs/mail.log (persisten, bisa dicek di hosting).
// Format per baris: waktu | ke | subjek | hasil
function mailLog(to, subject, result) {
  try {
    const dir = path.join(__dirname, '..', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} | to=${to} | ${subject} | ${result}\n`;
    fs.appendFile(path.join(dir, 'mail.log'), line, () => {});
  } catch (e) {}
}

function isMailConfigured() {
  return Boolean(
    nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  );
}

function getTransporter() {
  if (transporter) return transporter;
  if (!nodemailer || !isMailConfigured()) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const secureFlag = String(process.env.SMTP_SECURE || '').toLowerCase();
  const secure = secureFlag === 'true' || (secureFlag === '' && port === 465);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return transporter;
}

function getFrom() {
  // Abaikan MAIL_FROM yang bukan alamat email (typo config) agar kirim tidak gagal total.
  const raw = String(process.env.MAIL_FROM || '').trim();
  if (raw && raw.includes('@')) return raw;
  if (raw) console.error('[mailer] MAIL_FROM tidak valid ("%s") — pakai default.', raw);
  const user = process.env.SMTP_USER || 'info@knab.co.id';
  return `Sewa Lahan BSS <${user}>`;
}

// Data brand bersama untuk semua template email (nama + logo absolut + URL app).
async function emailBrand() {
  let brand = { name: 'BSS', full: 'Sewa Lahan BSS', logo: '/img/logo.png' };
  try {
    brand = await require('./companyProfile').getBrand();
  } catch (e) {}
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const logoPath = String(brand.logo || '/img/logo.png');
  const logoUrl = /^https?:\/\//i.test(logoPath) ? logoPath : (base ? base + logoPath : logoPath);
  return {
    brandName: brand.name,
    brandFull: brand.full,
    logoUrl,
    appUrl: base || 'https://knab.co.id',
  };
}

function renderEmail(template, data) {
  return ejs.renderFile(path.join(__dirname, '..', 'views', 'emails', template), data);
}

async function sendMail({ to, subject, html, text }) {
  if (!nodemailer) {
    console.error('[mailer] %s Email ke %s dilewati (subjek: %s)', mailerInstallHint(), to, subject);
    mailLog(to, subject, 'SKIP nodemailer-belum-terinstall');
    return { ok: false, skipped: true, error: mailerInstallHint() };
  }
  const t = getTransporter();
  if (!t) {
    console.error('[mailer] SMTP belum dikonfigurasi — email ke %s dilewati (subjek: %s)', to, subject);
    mailLog(to, subject, 'SKIP smtp-belum-dikonfigurasi');
    return { ok: false, skipped: true };
  }
  try {
    const info = await t.sendMail({ from: getFrom(), to, subject, html, text: text || undefined });
    mailLog(to, subject, `OK id=${info.messageId}`);
    return { ok: true, id: info.messageId };
  } catch (err) {
    console.error('[mailer] Gagal kirim email ke %s: %s', to, err && err.message);
    mailLog(to, subject, `FAIL ${err && err.message}`);
    return { ok: false, error: err && err.message };
  }
}

// Fire-and-forget: jangan await di controller.
function sendMailAsync(opts) {
  sendMail(opts).catch((e) => console.error('[mailer] async error:', e && e.message));
}

module.exports = { isMailConfigured, isMailerAvailable, mailerInstallHint, getFrom, emailBrand, renderEmail, sendMail, sendMailAsync };
