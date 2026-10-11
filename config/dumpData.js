/* Ekspor DATA (tanpa skema) satu database menjadi file .sql siap impor.
 * Dipakai untuk sinkronisasi lokal -> hosting (mis. jap -> knabcoid_knab).
 * Memakai REPLACE INTO: baris dgn id yg sama di-D update, yg baru di-insert,
 * baris yg hanya ada di tujuan TIDAK dihapus (aman untuk data produksi).
 *
 * Cara pakai:
 *   node config/dumpData.js [nama_database_sumber] [file_output]
 *   contoh: node config/dumpData.js jap sync-jap-ke-knabcoid_knab.sql
 *   - tanpa argumen: sumber = process.env.DB_NAME / 'jap', output = sync-<db>-<tanggal>.sql
 *
 * Mode skema (tanpa data, aman untuk database berisi):
 *   node config/dumpData.js --schema [nama_database_sumber] [file_output]
 *   contoh: node config/dumpData.js --schema jap knabcoid_knab.sql
 *   - hanya CREATE TABLE IF NOT EXISTS (tanpa DROP, tanpa INSERT) sehingga
 *     data yang sudah ada TIDAK tersentuh; tabel yang belum ada dibuatkan.
 *   - kolom baru di tabel lama ditangani: node config/upgradeDb.js knabcoid_knab
 *   - tanpa argumen output: knabcoid_knab.sql
 *
 * Urutan di hosting (phpMyAdmin):
 *   1) Backup dulu: Export database tujuan (jaga-jaga).
 *   2) Pastikan skema terbaru: impor dump skema (bila DB masih kosong)
 *      lalu jalankan: node config/upgradeDb.js knabcoid_knab
 *   3) Impor file hasil script ini (Import).
 *   4) Upload folder public/uploads yg baru/berubah via FTP/File Manager
 *      (SQL hanya membawa path /uploads/..., bukan file gambarnya).
 *   5) Login dgn akun dari database sumber (password ikut tertimpa).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const ARGS = process.argv.slice(2).filter((a) => a !== '--schema');
const SCHEMA_ONLY = process.argv.includes('--schema');
const SRC_DB = ARGS[0] || process.env.DB_NAME || 'jap';
const stamp = new Date().toISOString().slice(0, 10);
const OUT_FILE = ARGS[1] || (SCHEMA_ONLY ? 'knabcoid_knab.sql' : `sync-${SRC_DB}-ke-knabcoid_knab-${stamp}.sql`);

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    port: Number(process.env.DB_PORT || 3306),
    dateStrings: true,
  });
  const [dbRows] = await conn.query('SHOW DATABASES LIKE ?', [SRC_DB]);
  if (!dbRows.length) throw new Error(`Database sumber "${SRC_DB}" tidak ditemukan.`);
  await conn.query(`USE \`${SRC_DB}\``);

  const [tables] = await conn.query('SHOW FULL TABLES WHERE Table_type = ?', ['BASE TABLE']);
  const names = tables.map((t) => Object.values(t)[0]).sort();

  if (SCHEMA_ONLY) {
    await dumpSchema(conn, names);
    await conn.end();
    return;
  }

  const out = [];
  out.push('-- ============================================================');
  out.push(`-- Sinkronisasi DATA ${SRC_DB} -> knabcoid_knab (REPLACE = update/insert)`);
  out.push(`-- Dibuat : ${new Date().toISOString()}`);
  out.push('-- PENTING: backup database tujuan dulu (Export) sebelum impor!');
  out.push('-- Pastikan skema tujuan terbaru: node config/upgradeDb.js knabcoid_knab');
  out.push('-- Foto public/uploads disalin manual via FTP (tidak ikut file ini).');
  out.push('-- ============================================================');
  out.push('');
  out.push('SET FOREIGN_KEY_CHECKS=0;');
  out.push('SET NAMES utf8mb4;');
  out.push('USE `knabcoid_knab`;');
  out.push('');

  let totalRows = 0;
  for (const tbl of names) {
    const [cols] = await conn.query(`SHOW COLUMNS FROM \`${tbl}\``);
    const colNames = cols.map((c) => `\`${c.Field}\``).join(', ');
    const [rows] = await conn.query(`SELECT * FROM \`${tbl}\``);
    out.push(`-- ---- ${tbl} (${rows.length} baris) ----`);
    if (!rows.length) {
      out.push('');
      continue;
    }
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const vals = slice.map((r) => {
        const vs = cols.map((c) => {
          const v = r[c.Field];
          if (v === null || v === undefined) return 'NULL';
          return conn.escape(v);
        });
        return `(${vs.join(', ')})`;
      });
      out.push(`REPLACE INTO \`${tbl}\` (${colNames}) VALUES\n${vals.join(',\n')};`);
    }
    out.push('');
    totalRows += rows.length;
  }
  out.push('SET FOREIGN_KEY_CHECKS=1;');
  out.push('');

  const abs = path.isAbsolute(OUT_FILE) ? OUT_FILE : path.join(__dirname, '..', OUT_FILE);
  fs.writeFileSync(abs, out.join('\n'), 'utf8');
  console.log(`OK: ${names.length} tabel, ${totalRows} baris -> ${abs}`);
  await conn.end();
}

// Mode --schema: tulis struktur tabel TANPA data.
// Aman diimpor ke database berisi: tanpa DROP TABLE (pakai IF NOT EXISTS),
// tanpa INSERT, tanpa AUTO_INCREMENT counter — data lama tidak tersentuh.
// Kolom baru di tabel lama tetap ditangani upgradeDb.js (idempotent).
async function dumpSchema(conn, names) {
  const out = [];
  out.push('-- ============================================================');
  out.push(`-- SKEMA ${SRC_DB} -> knabcoid_knab (struktur saja, TANPA DATA)`);
  out.push(`-- Dibuat : ${new Date().toISOString()}`);
  out.push('-- AMAN diimpor ke database berisi: tanpa DROP, tanpa INSERT,');
  out.push('-- data yang sudah ada TIDAK tersentuh; tabel yg belum ada dibuatkan.');
  out.push('-- Sesudah impor jalankan: node config/upgradeDb.js knabcoid_knab');
  out.push('-- (menambah kolom/tabel baru yg belum tercakup file ini).');
  out.push('-- ============================================================');
  out.push('');
  out.push('SET FOREIGN_KEY_CHECKS=0;');
  out.push('SET NAMES utf8mb4;');
  out.push('USE `knabcoid_knab`;');
  out.push('');
  for (const tbl of names) {
    const [rows] = await conn.query(`SHOW CREATE TABLE \`${tbl}\``);
    let ddl = rows[0]['Create Table'];
    ddl = ddl.replace(/^CREATE TABLE `/, 'CREATE TABLE IF NOT EXISTS `');
    ddl = ddl.replace(/ AUTO_INCREMENT=\d+/, '');
    out.push(`-- ---- ${tbl} ----`);
    out.push(ddl + ';');
    out.push('');
  }
  out.push('SET FOREIGN_KEY_CHECKS=1;');
  out.push('');
  const abs = path.isAbsolute(OUT_FILE) ? OUT_FILE : path.join(__dirname, '..', OUT_FILE);
  fs.writeFileSync(abs, out.join('\n'), 'utf8');
  console.log(`OK: skema ${names.length} tabel (tanpa data) -> ${abs}`);
}

main().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
