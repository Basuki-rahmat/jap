const { query, get } = require('../models/db');

async function ensureSettingsTable() {
  try {
    await query(
      `CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(100) PRIMARY KEY,
        \`value\` TEXT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`
    );
  } catch (err) {
    // Abaikan: DB mungkin read-only / belum siap; pemanggil pakai fallback
    console.error('Ensure settings table error:', err.message);
  }
}

async function getSetting(key, fallback = '') {
  try {
    const row = await get('SELECT `value` FROM settings WHERE `key` = ? LIMIT 1', [key]);
    if (!row || row.value === null || typeof row.value === 'undefined') return fallback;
    return String(row.value);
  } catch (err) {
    // Tabel belum ada (belum migrasi) -> pakai fallback agar halaman tidak 500
    return fallback;
  }
}

async function setSetting(key, value) {
  await ensureSettingsTable();
  await query(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    [key, value]
  );
}

// ---- Pengaturan proposal vendor (admin/settings) ----
const PROPOSAL_ATTACHMENTS = [
  ['ktp', 'KTP Pemilik'],
  ['legal', 'Dokumen Legalitas (SHM/PBB)'],
  ['family', 'KK / Buku Nikah'],
  ['sewa', 'Surat Sewa'],
  ['support', 'Dokumen Pendukung'],
  ['foto_sebrang', 'Foto Sebrang Jalan'],
  ['foto_jaringan', 'Foto Jaringan Listrik'],
  ['foto_spot', 'Foto Penempatan ±3/4 m'],
  ['foto_kanan', 'Foto Sudut Kanan'],
  ['foto_kiri', 'Foto Sudut Kiri'],
  ['foto_selfie', 'Foto Selfie Pemilik'],
  ['foto_maps', 'Screenshot Koordinat'],
];

async function getProposalSettings() {
  const yearsRaw = String(await getSetting('proposal_contract_years', '5')).trim();
  const raw = String(await getSetting('proposal_attachments', '')).trim();
  const allowed = new Set(PROPOSAL_ATTACHMENTS.map((a) => a[0]));
  const attachments = raw
    ? raw.split(',').map((s) => s.trim()).filter((s) => allowed.has(s))
    : PROPOSAL_ATTACHMENTS.map((a) => a[0]);
  const notes = String(await getSetting('proposal_notes', '')).trim();
  return {
    contractYears: /^[1-9]\d?$/.test(yearsRaw) ? yearsRaw : '5',
    attachments: attachments.length ? attachments : PROPOSAL_ATTACHMENTS.map((a) => a[0]),
    notes,
  };
}

module.exports = { ensureSettingsTable, getSetting, setSetting, PROPOSAL_ATTACHMENTS, getProposalSettings };
