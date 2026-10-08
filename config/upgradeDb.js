/* Upgrade skema database JAP tanpa menghapus data.
 * Dipakai lokal maupun hosting setiap ada kolom/constraint baru.
 * Idempotent: aman dijalankan berulang kali.
 *
 * Cara pakai:
 *   node config/upgradeDb.js [nama_database]
 *   - tanpa argumen: pakai process.env.DB_NAME atau 'jap'
 *   - contoh hosting: node config/upgradeDb.js fadlanbe_jap
 * Koneksi memakai DB_HOST/DB_USER/DB_PASSWORD/DB_PORT dari .env
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const DB_NAME = process.argv[2] || process.env.DB_NAME || 'jap';

async function addColumns(conn, table, cols) {
  for (const c of cols) {
    try {
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${c}`);
      console.log(`  + ${table}.${c.split(' ')[0]}`);
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') console.log(`  = ${table}.${c.split(' ')[0]} sudah ada`);
      else throw err;
    }
  }
}

async function addUnique(conn, table, keyName, column) {
  // Lewati bila ada data ganda (agar upgrade tidak gagal di data produksi lama)
  const [dup] = await conn.query(
    `SELECT ${column} v, COUNT(*) c FROM \`${table}\` WHERE ${column} IS NOT NULL GROUP BY ${column} HAVING c > 1 LIMIT 1`
  );
  if (dup.length) {
    console.log(`  ! ${table}.${column}: ada nilai ganda (${dup[0].v}) -> constraint ${keyName} DILEWATI, rapikan data dulu`);
    return;
  }
  try {
    await conn.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${keyName}\` (\`${column}\`)`);
    console.log(`  + UNIQUE ${table}.${column}`);
  } catch (err) {
    if (err.code === 'ER_DUP_KEYNAME' || err.code === 'ER_DUP_ENTRY') {
      console.log(`  = UNIQUE ${table}.${column} sudah ada`);
    } else throw err;
  }
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    port: Number(process.env.DB_PORT || 3306),
    multipleStatements: true,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  await conn.query(`USE \`${DB_NAME}\``);
  console.log(`Upgrade "${DB_NAME}" (data dipertahankan)...`);

  // settings (pengaturan nama usaha dkk.)
  await conn.query(
    `CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(100) PRIMARY KEY,
      \`value\` TEXT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`
  );
  console.log('  = settings siap');

  // lands
  await addColumns(conn, 'lands', [
    '`location_address` TEXT NULL AFTER `address`',
    "`unit_type` ENUM('bss_motor','evcs_mobil') NOT NULL DEFAULT 'bss_motor' AFTER `area_size`",
    "`location_type` VARCHAR(100) NOT NULL DEFAULT '' AFTER `unit_type`",
    "`floor_ready` ENUM('ya','tidak') NULL AFTER `location_type`",
    "`has_canopy` ENUM('ya','tidak') NULL AFTER `floor_ready`",
    "`legal_doc_type` ENUM('shm','pbb') NULL AFTER `has_canopy`",
    '`maps_link` TEXT NULL AFTER `legal_doc_type`',
    '`ktp_file` VARCHAR(255) NULL AFTER `maps_link`',
    '`photo_1_file` VARCHAR(255) NULL AFTER `ktp_file`',
    '`photo_2_file` VARCHAR(255) NULL AFTER `photo_1_file`',
    '`photo_3_file` VARCHAR(255) NULL AFTER `photo_2_file`',
    '`legal_doc_file` VARCHAR(255) NULL AFTER `photo_3_file`',
    '`family_doc_file` VARCHAR(255) NULL AFTER `legal_doc_file`',
    '`sppl_file` VARCHAR(255) NULL AFTER `family_doc_file`',
    // Keperluan pemotretan: 3 foto sudut + selfie pemilik + screenshot koordinat + surat sewa + pendukung + slot manual
    '`photo_spot_file` VARCHAR(255) NULL AFTER `photo_3_file`',
    '`photo_right_file` VARCHAR(255) NULL AFTER `photo_spot_file`',
    '`photo_left_file` VARCHAR(255) NULL AFTER `photo_right_file`',
    '`photo_selfie_file` VARCHAR(255) NULL AFTER `photo_left_file`',
    '`photo_maps_file` VARCHAR(255) NULL AFTER `photo_selfie_file`',
    '`sewa_doc_file` VARCHAR(255) NULL AFTER `family_doc_file`',
    '`support_doc_file` VARCHAR(255) NULL AFTER `sewa_doc_file`',
    '`slot_no` TINYINT NULL',
    // Harga sewa per tipe (boleh kosong); harga_sewa lama dipertahankan sebagai cermin.
    '`harga_sewa_bss` INT NULL',
    '`harga_sewa_evcs` INT NULL',
    '`edit_token` VARCHAR(64) NULL AFTER `sppl_file`',
    '`edit_expires` DATETIME NULL AFTER `edit_token`',
    "`survey_status` ENUM('belum','lolos','gagal') NOT NULL DEFAULT 'belum' AFTER `status`",
    "`verify_status` ENUM('belum','lolos','gagal') NOT NULL DEFAULT 'belum' AFTER `survey_status`",
    '`bank_name` VARCHAR(100) NULL AFTER `phone_number`',
    '`account_number` VARCHAR(50) NULL AFTER `bank_name`',
    '`nik` VARCHAR(20) NULL AFTER `account_number`',
  ]);

  // Backfill harga per tipe dari kolom lama (sekali saja; baris yang sudah terisi tak disentuh).
  try {
    const [b1] = await conn.query(
      "UPDATE `lands` SET `harga_sewa_bss` = `harga_sewa` WHERE `unit_type` = 'bss_motor' AND `harga_sewa` IS NOT NULL AND `harga_sewa_bss` IS NULL"
    );
    const [b2] = await conn.query(
      "UPDATE `lands` SET `harga_sewa_evcs` = `harga_sewa` WHERE `unit_type` = 'evcs_mobil' AND `harga_sewa` IS NOT NULL AND `harga_sewa_evcs` IS NULL"
    );
    const n = Number(b1.affectedRows || 0) + Number(b2.affectedRows || 0);
    if (n) console.log(`  ~ lands.harga per tipe di-backfill: ${n} baris`);
  } catch (e) {
    console.log('  ! backfill harga per tipe dilewati:', e.message);
  }

  // users
  await addColumns(conn, 'users', [
    '`whatsapp` VARCHAR(20) NULL AFTER `email`',
    '`nik` VARCHAR(20) NULL AFTER `whatsapp`',
    '`bank_name` VARCHAR(100) NULL AFTER `nik`',
    '`account_number` VARCHAR(50) NULL AFTER `bank_name`',
    '`photo_file` VARCHAR(255) NULL AFTER `account_number`',
    '`ktp_file` VARCHAR(255) NULL AFTER `photo_file`',
    "`fee_type` ENUM('rupiah','persen') NULL AFTER `ktp_file`",
    '`fee_value` DECIMAL(12,2) DEFAULT 0 AFTER `fee_type`',
    '`downline_quota` INT DEFAULT 0 AFTER `parent_id`',
    '`is_head` TINYINT(1) DEFAULT 0 AFTER `downline_quota`',
    '`is_coordinator` TINYINT(1) DEFAULT 0 AFTER `is_head`',
  ]);
  await addUnique(conn, 'users', 'uniq_nik', 'nik');
  await addUnique(conn, 'users', 'uniq_whatsapp', 'whatsapp');

  // Pendaftaran marketing publik: status akun + token verifikasi email.
  // pending_verification = baru daftar, belum klik link email.
  // pending_approval = email terverifikasi, menunggu persetujuan admin.
  // active = bisa login (nilai untuk semua akun lama).
  await addColumns(conn, 'users', [
    "`mkt_status` ENUM('pending_verification','pending_approval','active') NOT NULL DEFAULT 'active'",
    '`email_verify_token` VARCHAR(64) NULL',
    '`email_verify_expires` DATETIME NULL',
    // Lupa password: token reset sekali pakai (kedaluwarsa 1 jam).
    '`reset_token` VARCHAR(64) NULL',
    '`reset_expires` DATETIME NULL',
  ]);
  try {
    const [upd] = await conn.query(
      "UPDATE `users` SET `mkt_status` = 'active' WHERE `mkt_status` IS NULL OR `mkt_status` = ''"
    );
    if (upd.affectedRows) console.log(`  ~ users.mkt_status di-backfill: ${upd.affectedRows} baris`);
  } catch (e) {
    console.log('  ! backfill users.mkt_status dilewati:', e.message);
  }

  // fee_logs
  await addColumns(conn, 'fee_logs', [
    "`status` ENUM('unpaid','paid') NOT NULL DEFAULT 'unpaid' AFTER `amount`",
    '`paid_at` DATETIME NULL AFTER `status`',
  ]);

  // Ringkasan data (bukti tidak ada yang hilang)
  for (const t of ['users', 'lands', 'fee_logs', 'settings']) {
    try {
      const [r] = await conn.query(`SELECT COUNT(*) c FROM \`${t}\``);
      console.log(`  # ${t}: ${r[0].c} baris`);
    } catch (e) {
      console.log(`  # ${t}: (belum ada)`);
    }
  }

  await conn.end();
  console.log('Upgrade selesai.');
}

main().catch((err) => {
  console.error('Upgrade gagal:', err.message);
  process.exit(1);
});
