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

-- 4) Verifikasi (hasilnya tampil setelah import):
SELECT COUNT(*) AS fee_rules_rows FROM `fee_rules`;
SHOW COLUMNS FROM `fee_logs`;
