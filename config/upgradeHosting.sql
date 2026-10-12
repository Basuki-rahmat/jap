-- =====================================================================
-- PATCH HOSTING (aman, tanpa hapus data) — fitur Fee berjenjang
-- Cara pakai (bila hosting TIDAK ada SSH/terminal):
--   phpMyAdmin -> pilih database hosting -> menu Import ->
--   pilih file ini -> Go.
-- Sifat: idempotent (aman dijalankan berulang), hanya TAMBAH tabel/kolom
-- yang belum ada, TIDAK menghapus / menimpa data lama.
-- Catatan: bila hosting ADA akses SSH/terminal, cara utama yang disarankan
-- justru:  npm run upgrade-db  atau  node config/upgradeDb.js <nama_db>
-- (mencakup SEMUA kolom, bukan hanya fee).
-- =====================================================================

-- 1) Tabel khusus matriks fee (2 tipe x 5 wilayah = 10 baris).
CREATE TABLE IF NOT EXISTS `fee_rules` (
  `unit_type` ENUM('bss','evcs') NOT NULL,
  `wilayah` VARCHAR(30) NOT NULL,
  `koordinator` INT NOT NULL DEFAULT 0,
  `head` INT NOT NULL DEFAULT 0,
  `marketing` INT NOT NULL DEFAULT 0,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`unit_type`, `wilayah`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Isi default. INSERT IGNORE = baris yang sudah ada TIDAK ditimpa,
--    jadi nilai fee yang sudah diubah via /admin/settings di hosting aman.
INSERT IGNORE INTO `fee_rules` (`unit_type`, `wilayah`, `koordinator`, `head`, `marketing`) VALUES
('bss', 'dki_jakarta', 900000, 500000, 300000),
('bss', 'bogor',       700000, 450000, 300000),
('bss', 'depok',       700000, 450000, 300000),
('bss', 'tangerang',   700000, 450000, 300000),
('bss', 'bekasi',      700000, 450000, 300000),
('evcs', 'dki_jakarta', 1500000, 800000, 500000),
('evcs', 'bogor',       1200000, 750000, 500000),
('evcs', 'depok',       1200000, 750000, 500000),
('evcs', 'tangerang',   1200000, 750000, 500000),
('evcs', 'bekasi',      1200000, 750000, 500000);

-- 3) Kolom audit di fee_logs. Prosedur cek INFORMATION_SCHEMA dulu,
--    sehingga import tidak gagal/berhenti bila kolom sudah ada.
DELIMITER $$
DROP PROCEDURE IF EXISTS `__jap_add_column` $$
CREATE PROCEDURE `__jap_add_column`(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_def TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_column
  ) THEN
    SET @__jap_sql := CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN ', p_def);
    PREPARE __jap_stmt FROM @__jap_sql;
    EXECUTE __jap_stmt;
    DEALLOCATE PREPARE __jap_stmt;
  END IF;
END $$
DELIMITER ;

CALL `__jap_add_column`('fee_logs', 'fee_role', "`fee_role` ENUM('marketing','head','koordinator') NULL AFTER `marketing_id`");
CALL `__jap_add_column`('fee_logs', 'wilayah', "`wilayah` VARCHAR(30) NULL AFTER `fee_role`");
CALL `__jap_add_column`('fee_logs', 'unit_type', "`unit_type` VARCHAR(20) NULL AFTER `wilayah`");
CALL `__jap_add_column`('fee_logs', 'gross_amount', "`gross_amount` INT NULL AFTER `amount`");

DROP PROCEDURE IF EXISTS `__jap_add_column`;

-- 3b) Kunci unik 2 baris per penyedia (1 BSS + 1 EVCS). Idempotent: cek
--     INFORMATION_SCHEMA dulu; DILEWATI bila masih ada data ganda.
DELIMITER $$
DROP PROCEDURE IF EXISTS `__jap_add_unique` $$
CREATE PROCEDURE `__jap_add_unique`()
BEGIN
  DECLARE dup_n INT DEFAULT 0;
  DECLARE key_n INT DEFAULT 0;
  SELECT COUNT(*) INTO dup_n FROM (
    SELECT phone_number, unit_type FROM `lands`
    GROUP BY phone_number, unit_type HAVING COUNT(*) > 1 LIMIT 1
  ) d;
  SELECT COUNT(*) INTO key_n FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lands' AND INDEX_NAME = 'uniq_phone_unit';
  IF dup_n = 0 AND key_n = 0 THEN
    ALTER TABLE `lands` ADD UNIQUE KEY `uniq_phone_unit` (`phone_number`, `unit_type`);
  END IF;
END $$
DELIMITER ;

CALL `__jap_add_unique`();
DROP PROCEDURE IF EXISTS `__jap_add_unique`;

-- 4) Verifikasi (hasilnya tampil setelah import):
SELECT COUNT(*) AS fee_rules_rows FROM `fee_rules`;
SHOW COLUMNS FROM `fee_logs`;

-- =====================================================================
-- 5) DOMPET FEE: saldo mitra, buku mutasi, dan pengajuan penarikan.
--    Mitra mengajukan penarikan di /marketing/penarikan, admin memproses
--    di /admin/pembayaran.
-- =====================================================================

-- Saldo aktif per mitra (sudah dikurangi hold penarikan yang masih jalan).
CREATE TABLE IF NOT EXISTS `user_wallets` (
  `user_id` INT NOT NULL,
  `balance` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Buku mutasi rupiah: kredit fee, hold penarikan, refund, reversal fee batal.
-- Kunci unik (source, ref_table, ref_id) membuat proses approve/reversal
-- yang terulang tidak menggandakan saldo.
CREATE TABLE IF NOT EXISTS `wallet_ledger` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `kind` ENUM('credit','debit') NOT NULL,
  `source` ENUM('fee','withdrawal','withdrawal_refund','fee_reversal','adjustment') NOT NULL,
  `ref_table` VARCHAR(30) NULL,
  `ref_id` INT NULL,
  `amount` DECIMAL(14,2) NOT NULL,
  `balance_after` DECIMAL(14,2) NOT NULL,
  `note` VARCHAR(255) NULL,
  `actor_id` INT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_ref` (`source`, `ref_table`, `ref_id`),
  KEY `user_created` (`user_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pengajuan penarikan dana mitra + jejak proses admin (bukti transfer dll).
CREATE TABLE IF NOT EXISTS `withdrawals` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL,
  `bank_name` VARCHAR(100) NULL,
  `account_number` VARCHAR(50) NULL,
  `account_name` VARCHAR(100) NULL,
  `status` ENUM('pending','processing','paid','rejected','cancelled') NOT NULL DEFAULT 'pending',
  `admin_note` VARCHAR(255) NULL,
  `reject_reason` VARCHAR(255) NULL,
  `transfer_ref` VARCHAR(100) NULL,
  `proof_file` VARCHAR(255) NULL,
  `requested_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `processed_at` DATETIME NULL,
  `paid_at` DATETIME NULL,
  `processed_by` INT NULL,
  PRIMARY KEY (`id`),
  KEY `user_status` (`user_id`, `status`, `id`),
  KEY `status_created` (`status`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6) Backfill: fee approved sebelum fitur dompet ada dihitung sebagai kredit
--    saldo. INSERT IGNORE = baris yang sudah tercatat tidak digandakan,
--    jadi import aman diulang. Setelah itu saldo dihitung ulang dari ledger.
INSERT IGNORE INTO `user_wallets` (`user_id`, `balance`)
SELECT DISTINCT `marketing_id`, 0 FROM `fee_logs` WHERE `marketing_id` IS NOT NULL;

INSERT IGNORE INTO `wallet_ledger`
  (`user_id`, `kind`, `source`, `ref_table`, `ref_id`, `amount`, `balance_after`, `note`)
SELECT f.`marketing_id`, 'credit', 'fee', 'fee_logs', f.`id`, f.`amount`,
       (SELECT COALESCE(SUM(f2.`amount`), 0) FROM `fee_logs` f2
         WHERE f2.`marketing_id` = f.`marketing_id` AND f2.`id` <= f.`id`),
       CONCAT('Fee lahan #', COALESCE(f.`land_id`, '-'), ' (migrasi)')
FROM `fee_logs` f
WHERE f.`marketing_id` IS NOT NULL AND f.`amount` > 0;

UPDATE `user_wallets` w
SET w.`balance` = (
  SELECT COALESCE(SUM(CASE WHEN l.`kind` = 'credit' THEN l.`amount` ELSE -l.`amount` END), 0)
  FROM `wallet_ledger` l WHERE l.`user_id` = w.`user_id`
);

-- 8) Role admin setara superadmin (idempotent: MODIFY ke definisi yang sama aman diulang).
ALTER TABLE `users` MODIFY `role` ENUM('superadmin','admin','marketing') NOT NULL;

-- 7) Verifikasi dompet
SELECT COUNT(*) AS wallet_ledger_rows, COALESCE(SUM(amount),0) AS wallet_total
FROM `wallet_ledger` WHERE `source` = 'fee';
SELECT `user_id`, `balance` FROM `user_wallets` ORDER BY `balance` DESC LIMIT 10;

-- =====================================================================
-- 9) PERINGATAN PERANGKAT BARU: jejak login per user untuk email notif.
--    Idempotent, tanpa hapus data.
-- =====================================================================
CREATE TABLE IF NOT EXISTS `user_devices` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `device_hash` CHAR(64) NOT NULL,
  `device_name` VARCHAR(100) NULL,
  `user_agent` VARCHAR(500) NULL,
  `last_ip` VARCHAR(45) NULL,
  `first_seen` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `last_seen` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_user_device` (`user_id`, `device_hash`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
