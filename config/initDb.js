require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'jap';

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

  console.log(`Database "${DB_NAME}" siap.`);

  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      whatsapp VARCHAR(20) NULL,
      fee_type ENUM('rupiah','persen') NULL,
      fee_value DECIMAL(12,2) DEFAULT 0,
      password VARCHAR(255) NOT NULL,
      role ENUM('superadmin','marketing') NOT NULL,
      referral_code VARCHAR(20) UNIQUE,
      parent_id INT NULL,
      downline_quota INT DEFAULT 0,
      is_head TINYINT(1) DEFAULT 0,
      is_coordinator TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES users(id)
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS lands (
      id INT PRIMARY KEY AUTO_INCREMENT,
      marketing_id INT NULL,
      owner_name VARCHAR(100) NOT NULL,
      phone_number VARCHAR(20) NOT NULL,
      address TEXT NOT NULL,
      area_size VARCHAR(50) NOT NULL,
      status ENUM('pending','approved','rejected') DEFAULT 'pending',
      fee_amount DECIMAL(12,2) DEFAULT 0.00,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (marketing_id) REFERENCES users(id)
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS fee_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      marketing_id INT NOT NULL,
      land_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (marketing_id) REFERENCES users(id),
      FOREIGN KEY (land_id) REFERENCES lands(id)
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(100) PRIMARY KEY,
      \`value\` TEXT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,
  ];

  for (const s of statements) {
    await conn.query(s);
  }
  console.log('Tabel users, lands, fee_logs, settings siap.');

  // Kunci akun marketing/head (kebijakan perusahaan): 0 aktif, 1 terkunci.
  try {
    await conn.query('ALTER TABLE users ADD COLUMN is_locked TINYINT(1) DEFAULT 0 AFTER is_head');
    console.log('Kolom users.is_locked ditambahkan (kunci akun).');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  // Notifikasi dua arah: admin <-> marketing/head.
  // Satu baris per penerima (fan-out saat kirim) agar status dibaca per orang.
  // target_phone = slot kanal penyedia lahan (nantinya: inbox /lacak / WA).
  try {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS notifications (
        id INT PRIMARY KEY AUTO_INCREMENT,
        sender_id INT NULL,
        target_user_id INT NOT NULL,
        target_phone VARCHAR(20) NULL,
        title VARCHAR(150) NOT NULL,
        body TEXT NULL,
        link VARCHAR(500) NULL,
        is_read TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY target_user (target_user_id, is_read, id),
        KEY target_phone (target_phone)
      ) ENGINE=InnoDB`
    );
    console.log('Tabel notifications siap.');
  } catch (err) {
    throw err;
  }

  // API mobile: refresh token (hash) + token push FCM per perangkat.
  await conn.query(
    `CREATE TABLE IF NOT EXISTS api_tokens (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      device_name VARCHAR(100) NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_hash (token_hash),
      KEY user_id (user_id, expires_at)
    ) ENGINE=InnoDB`
  );
  console.log('Tabel api_tokens siap.');
  await conn.query(
    `CREATE TABLE IF NOT EXISTS device_tokens (
      user_id INT NOT NULL,
      platform ENUM('android','ios') NOT NULL DEFAULT 'android',
      token VARCHAR(255) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, token(191)),
      KEY user_id (user_id)
    ) ENGINE=InnoDB`
  );
  console.log('Tabel device_tokens siap.');

  try {
    await conn.query(`ALTER TABLE users ADD COLUMN whatsapp VARCHAR(20) NULL AFTER email`);
    console.log('Kolom users.whatsapp ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  try {
    await conn.query(`ALTER TABLE users ADD COLUMN fee_type ENUM('rupiah','persen') NULL AFTER whatsapp, ADD COLUMN fee_value DECIMAL(12,2) DEFAULT 0 AFTER fee_type`);
    console.log('Kolom users.fee_type, users.fee_value ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  // Data marketing: NIK unik + bank/rek + foto/KTP + WA unik (anti-double)
  // + wilayah untuk ID Card anggota.
  try {
    await conn.query(
      `ALTER TABLE users
       ADD COLUMN nik VARCHAR(20) NULL AFTER whatsapp,
       ADD COLUMN bank_name VARCHAR(100) NULL AFTER nik,
       ADD COLUMN account_number VARCHAR(50) NULL AFTER bank_name,
       ADD COLUMN wilayah VARCHAR(100) NULL AFTER account_number,
       ADD COLUMN photo_file VARCHAR(255) NULL AFTER wilayah,
       ADD COLUMN ktp_file VARCHAR(255) NULL AFTER photo_file`
    );
    console.log('Kolom users.nik, bank_name, account_number, wilayah, photo_file, ktp_file ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  // DB lama: blok di atas gagal total bila salah satu kolom sudah ada,
  // sehingga wilayah perlu ditambahkan terpisah agar tetap masuk.
  try {
    await conn.query('ALTER TABLE users ADD COLUMN wilayah VARCHAR(100) NULL AFTER account_number');
    console.log('Kolom users.wilayah ditambahkan (ID Card).');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  for (const uq of [
    'ALTER TABLE users ADD UNIQUE KEY uniq_nik (nik)',
    'ALTER TABLE users ADD UNIQUE KEY uniq_whatsapp (whatsapp)',
  ]) {
    try {
      await conn.query(uq);
      console.log('Constraint unik dibuat: ' + uq.match(/uniq_\w+/)[0]);
    } catch (err) {
      if (err.code !== 'ER_DUP_KEYNAME' && err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }

  try {
    await conn.query(
      `ALTER TABLE lands
       ADD COLUMN unit_type ENUM('bss_motor','evcs_mobil') NOT NULL DEFAULT 'bss_motor' AFTER area_size,
       ADD COLUMN location_type VARCHAR(100) NOT NULL DEFAULT '' AFTER unit_type,
       ADD COLUMN floor_ready ENUM('ya','tidak') NULL AFTER location_type,
       ADD COLUMN has_canopy ENUM('ya','tidak') NULL AFTER floor_ready,
       ADD COLUMN legal_doc_type ENUM('shm','pbb') NULL AFTER has_canopy,
       ADD COLUMN maps_link TEXT NULL AFTER legal_doc_type`
    );
    console.log('Kolom lands.unit_type, location_type, floor_ready, has_canopy, legal_doc_type, maps_link ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  try {
    await conn.query(
      `ALTER TABLE lands
       ADD COLUMN ktp_file VARCHAR(255) NULL AFTER maps_link,
       ADD COLUMN photo_1_file VARCHAR(255) NULL AFTER ktp_file,
       ADD COLUMN photo_2_file VARCHAR(255) NULL AFTER photo_1_file,
       ADD COLUMN photo_3_file VARCHAR(255) NULL AFTER photo_2_file,
       ADD COLUMN photo_spot_file VARCHAR(255) NULL AFTER photo_3_file,
       ADD COLUMN photo_right_file VARCHAR(255) NULL AFTER photo_spot_file,
       ADD COLUMN photo_left_file VARCHAR(255) NULL AFTER photo_right_file,
       ADD COLUMN photo_selfie_file VARCHAR(255) NULL AFTER photo_left_file,
       ADD COLUMN photo_maps_file VARCHAR(255) NULL AFTER photo_selfie_file,
       ADD COLUMN legal_doc_file VARCHAR(255) NULL AFTER photo_maps_file,
       ADD COLUMN family_doc_file VARCHAR(255) NULL AFTER legal_doc_file,
       ADD COLUMN sewa_doc_file VARCHAR(255) NULL AFTER family_doc_file,
       ADD COLUMN support_doc_file VARCHAR(255) NULL AFTER sewa_doc_file,
       ADD COLUMN slot_no TINYINT NULL,
       ADD COLUMN sppl_file VARCHAR(255) NULL AFTER family_doc_file`
    );
    console.log('Kolom lands.ktp_file, photo_1/2/3_file, legal_doc_file, family_doc_file, sppl_file ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  try {
    await conn.query(
      `ALTER TABLE lands
       ADD COLUMN location_address TEXT NULL AFTER address`
    );
    console.log('Kolom lands.location_address ditambahkan (alamat lokasi, terpisah dari alamat pemilik).');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  try {
    await conn.query(
      `ALTER TABLE lands
       ADD COLUMN survey_status ENUM('belum','sudah') NOT NULL DEFAULT 'belum' AFTER status`
    );
    console.log('Kolom lands.survey_status ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  try {
    await conn.query(
      `ALTER TABLE lands
       ADD COLUMN edit_token VARCHAR(64) NULL AFTER sppl_file,
       ADD COLUMN edit_expires DATETIME NULL AFTER edit_token`
    );
    console.log('Kolom lands.edit_token, edit_expires ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  // Tanda verifikasi & survei (✓ lolos / ✕ gagal)
  try {
    await conn.query(
      `ALTER TABLE lands
       ADD COLUMN verify_status ENUM('belum','lolos','gagal') NOT NULL DEFAULT 'belum' AFTER survey_status`
    );
    console.log('Kolom lands.verify_status ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await conn.query(
      `ALTER TABLE lands
       ADD COLUMN survey_status ENUM('belum','lolos','gagal') NOT NULL DEFAULT 'belum' AFTER status`
    );
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  // Migrasi nilai lama 'sudah' -> 'lolos', rapikan enum
  await conn.query(`ALTER TABLE lands MODIFY survey_status ENUM('belum','sudah','lolos','gagal') NOT NULL DEFAULT 'belum'`);
  await conn.query(`UPDATE lands SET survey_status = 'lolos' WHERE survey_status = 'sudah'`);
  await conn.query(`ALTER TABLE lands MODIFY survey_status ENUM('belum','lolos','gagal') NOT NULL DEFAULT 'belum'`);
  console.log('Enum survey_status dimigrasi ke belum/lolos/gagal.');

  // fee_logs: status pelunasan untuk menu pembayaran fee (nantinya)
  try {
    await conn.query(
      `ALTER TABLE fee_logs
       ADD COLUMN status ENUM('unpaid','paid') NOT NULL DEFAULT 'unpaid' AFTER amount,
       ADD COLUMN paid_at DATETIME NULL AFTER status`
    );
    console.log('Kolom fee_logs.status, paid_at ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  // Data pemilik: bank + rekening + NIK (Tahap 1)
  try {
    await conn.query(
      `ALTER TABLE lands
       ADD COLUMN bank_name VARCHAR(100) NULL AFTER phone_number,
       ADD COLUMN account_number VARCHAR(50) NULL AFTER bank_name,
       ADD COLUMN nik VARCHAR(20) NULL AFTER account_number`
    );
    console.log('Kolom lands.bank_name, account_number, nik ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  // Field ala referensi Japripay System.html (form pendataan lahan lama):
  // TTL, surat, nama toko, kota, kelurahan, harga sewa, lat_long, link maps manual
  try {
    await conn.query(
      `ALTER TABLE lands
       ADD COLUMN ttl VARCHAR(100) NULL AFTER nik,
       ADD COLUMN surat VARCHAR(255) NULL AFTER ttl,
       ADD COLUMN shop_name VARCHAR(150) NULL AFTER surat,
       ADD COLUMN city VARCHAR(100) NULL AFTER shop_name,
       ADD COLUMN district VARCHAR(100) NULL AFTER city,
       ADD COLUMN harga_sewa INT NULL AFTER district,
       ADD COLUMN harga_sewa_bss INT NULL AFTER harga_sewa,
       ADD COLUMN harga_sewa_evcs INT NULL AFTER harga_sewa_bss`
    );
    console.log('Kolom lands.ttl, surat, shop_name, city, district, harga_sewa ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await conn.query(
      `ALTER TABLE lands
       ADD COLUMN lat_long VARCHAR(60) NULL AFTER maps_link,
       ADD COLUMN maps_url TEXT NULL AFTER lat_long`
    );
    console.log('Kolom lands.lat_long, maps_url ditambahkan.');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  const [rows] = await conn.query('SELECT id FROM users WHERE role = ? LIMIT 1', ['superadmin']);
  if (rows.length === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await conn.query(
      'INSERT INTO users (name, email, password, role, downline_quota) VALUES (?)',
      [['Super Admin', 'admin@jap.id', hash, 'superadmin', 0]]
    );
    console.log('Super Admin dibuat -> email: admin@jap.id | password: admin123');
  } else {
    console.log('Super Admin sudah ada.');
  }

  const [mk] = await conn.query('SELECT id FROM users WHERE role = ? LIMIT 1', ['marketing']);
  if (mk.length === 0) {
    const hash = await bcrypt.hash('jap12345', 10);
    await conn.query(
      'INSERT INTO users (name, email, password, role, referral_code, downline_quota) VALUES (?)',
      [['Marketing Contoh', 'marketing@jap.id', hash, 'marketing', 'JAPCONTOH', 0]]
    );
    console.log('Marketing contoh dibuat -> email: marketing@jap.id | password: jap12345 | referral: JAPCONTOH');
  } else {
    console.log('Marketing contoh sudah ada.');
  }

  await conn.end();
  console.log('Inisialisasi selesai.');
}

main().catch((err) => {
  console.error('Gagal inisialisasi database:', err.message);
  process.exit(1);
});