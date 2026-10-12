// Dompet fee mitra: saldo + buku mutasi (ledger) + hold pengajuan penarikan.
//
// Pembagian tugas:
// - fee_logs       = catatan HAK fee per lahan × peran (audit, tidak diubah).
// - wallet_ledger  = buku mutasi rupiah: kredit fee, hold penarikan,
//                    refund saat ditolak/dibatalkan, reversal saat fee batal.
// - user_wallets.balance = saldo AKTIF (sudah dikurangi hold) agar tidak perlu
//                    agregasi SUM() setiap render. Selalu ditulis bersama baris
//                    ledger pada transaksi yang sama, sehingga invariannya:
//                    balance = SUM(kredit) - SUM(debit).
//
// Idempotensi: setiap mutasi punya kunci unik (source, ref_table, ref_id),
// jadi proses approve/reversal yang terulang tidak menggandakan saldo.
const { query, get } = require('../models/db');
const { getSetting } = require('./settings');

const MIN_WITHDRAW_DEFAULT = 50000;

// Pembungkus eksekutor: pool (models/db) atau koneksi transaksi mysql2.
// Idempotent: objek yang sudah berbentuk { q, ins } dikembalikan apa adanya,
// sehingga helper boleh saling memanggil tanpa membungkus dua kali.
function makeExec(conn) {
  if (conn && typeof conn.q === 'function' && typeof conn.ins === 'function') return conn;
  if (!conn) {
    return {
      q: (sql, params = []) => query(sql, params),
      ins: async (sql, params = []) => {
        const [r] = await require('../config/database').query(sql, params);
        return r.insertId;
      },
    };
  }
  return {
    q: async (sql, params = []) => {
      const [rows] = await conn.query(sql, params);
      return rows;
    },
    ins: async (sql, params = []) => {
      const [r] = await conn.query(sql, params);
      return r.insertId;
    },
  };
}

// Parser INPUT USER (format Indonesia): "300.000" = 300 ribu, "300,5" = 300,5.
// HANYA untuk nilai dari form/pengaturan, JANGAN untuk nilai dari kolom DB
// (DECIMAL MySQL berbentuk "300000.00" — titiknya desimal, bukan pemisah ribuan).
function toAmount(v) {
  const n = Math.floor(Number(String(v == null ? '' : v).replace(/\./g, '').replace(/,/g, '.')));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Parser NILAI DB/JSON (number atau string DECIMAL): "300000.00" = 300000.
function toNumber(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Nominal minimum penarikan (bisa diubah lewat settings `withdraw_min`).
async function minWithdraw() {
  const raw = String(await getSetting('withdraw_min', '')).trim();
  const n = toAmount(raw);
  return n > 0 ? n : MIN_WITHDRAW_DEFAULT;
}

async function ensureWalletRow(exec, userId) {
  await exec.q('INSERT IGNORE INTO user_wallets (user_id, balance) VALUES (?, 0)', [userId]);
}

// Satu mutasi saldo. WAJIB dipanggil dalam transaksi bila memakai `conn`
// (koneksi mysql2 pool.getConnection) atau null untuk pool default.
// Return { applied:false } bila mutasi referensi yang sama sudah pernah dicatat.
async function mutate(execInput, {
  userId, kind, source, refTable = null, refId = null, amount, note = null, actorId = null,
}) {
  const exec = makeExec(execInput);
  const uid = Number(userId);
  // amount di sini selalu angka/strings DECIMAL (bukan input mentah user).
  const amt = toNumber(amount);
  if (!uid || !amt) return { applied: false, balance: null };

  if (refId != null) {
    const dupe = await exec.q(
      'SELECT id FROM wallet_ledger WHERE source = ? AND ref_table <=> ? AND ref_id <=> ? LIMIT 1',
      [source, refTable, refId]
    );
    if (dupe.length) return { applied: false, balance: null };
  }

  await ensureWalletRow(exec, uid);
  // Di dalam transaksi, FOR UPDATE menyerialkan mutasi user yang sama.
  await exec.q('SELECT balance FROM user_wallets WHERE user_id = ? FOR UPDATE', [uid]);
  const delta = kind === 'credit' ? amt : -amt;
  // Relatif (balance = balance + delta) supaya mutasi bersamaan tidak saling menimpa.
  await exec.q('UPDATE user_wallets SET balance = balance + ? WHERE user_id = ?', [delta, uid]);
  const afterRows = await exec.q('SELECT balance FROM user_wallets WHERE user_id = ?', [uid]);
  const after = Number(afterRows.length ? afterRows[0].balance : 0);
  await exec.ins(
    `INSERT INTO wallet_ledger (user_id, kind, source, ref_table, ref_id, amount, balance_after, note, actor_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [uid, kind, source, refTable, refId, amt, after, note ? String(note).slice(0, 255) : null, actorId || null]
  );
  return { applied: true, balance: after };
}

// Fee lahan disetujui -> saldo mitra bertambah (kredit per baris fee_logs).
async function creditFee(exec, { userId, amount, feeLogId, landId, role, note, actorId }) {
  return mutate(makeExec(exec), {
    userId,
    kind: 'credit',
    source: 'fee',
    refTable: 'fee_logs',
    refId: feeLogId,
    amount,
    note: note || `Fee lahan #${landId}${role ? ' (' + role + ')' : ''}`,
    actorId,
  });
}

// Pengajuan penarikan -> saldo ditahan (debit) supaya tidak bisa ditarik dua kali.
async function holdWithdrawal(exec, { userId, amount, withdrawalId, note }) {
  return mutate(makeExec(exec), {
    userId,
    kind: 'debit',
    source: 'withdrawal',
    refTable: 'withdrawals',
    refId: withdrawalId,
    amount,
    note: note || `Pengajuan penarikan #${withdrawalId}`,
  });
}

// Pengajuan ditolak/dibatalkan -> saldo hold dikembalikan.
async function refundWithdrawal(exec, { userId, amount, withdrawalId, note }) {
  return mutate(makeExec(exec), {
    userId,
    kind: 'credit',
    source: 'withdrawal_refund',
    refTable: 'withdrawals',
    refId: withdrawalId,
    amount,
    note: note || `Pengembalian saldo penarikan #${withdrawalId}`,
  });
}

// Fee dibatalkan (lahan ditolak / kembali pending) -> kredit fee ditarik kembali.
// Saldo boleh menjadi minus bila dananya sudah ditarik/diproses: itu tanda
// mitra punya kewajiban, dan tampil apa adanya di halaman penarikan.
async function reverseFeesForLand(execInput, { landId, note, actorId }) {
  const exec = makeExec(execInput);
  const rows = await exec.q(
    'SELECT id, marketing_id, fee_role, amount FROM fee_logs WHERE land_id = ?',
    [landId]
  );
  let count = 0;
  let total = 0;
  for (const r of rows) {
    const res = await mutate(exec, {
      userId: r.marketing_id,
      kind: 'debit',
      source: 'fee_reversal',
      refTable: 'fee_logs',
      refId: r.id,
      amount: r.amount,
      note: note || `Pembatalan fee lahan #${landId}${r.fee_role ? ' (' + r.fee_role + ')' : ''}`,
      actorId,
    });
    if (res.applied) {
      count += 1;
      total += toNumber(r.amount);
    }
  }
  return { count, total };
}

// Ringkasan dompet satu user: saldo tersedia, fee masuk, diproses, diterima.
async function getWalletSummary(userId) {
  const uid = Number(userId) || 0;
  const empty = {
    balance: 0, feeTotal: 0, reversalTotal: 0, withdrawnTotal: 0,
    pendingAmount: 0, pendingCount: 0, paidAmount: 0, paidCount: 0,
  };
  if (!uid) return empty;
  try {
    const w = await get('SELECT balance FROM user_wallets WHERE user_id = ?', [uid]);
    const l = (await query(
      `SELECT COALESCE(SUM(CASE WHEN source = 'fee' THEN amount ELSE 0 END),0) fee_total,
              COALESCE(SUM(CASE WHEN source = 'fee_reversal' THEN amount ELSE 0 END),0) reversal_total,
              COALESCE(SUM(CASE WHEN source = 'withdrawal' THEN amount ELSE 0 END),0) hold_total
       FROM wallet_ledger WHERE user_id = ?`,
      [uid]
    ))[0];
    const d = (await query(
      `SELECT COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN amount ELSE 0 END),0) pending_amount,
              COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END),0) pending_count,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END),0) paid_amount,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END),0) paid_count
       FROM withdrawals WHERE user_id = ?`,
      [uid]
    ))[0];
    return {
      balance: Number(w ? w.balance : 0),
      feeTotal: Number(l.fee_total) - Number(l.reversal_total),
      reversalTotal: Number(l.reversal_total),
      withdrawnTotal: Number(l.hold_total),
      pendingAmount: Number(d.pending_amount),
      pendingCount: Number(d.pending_count),
      paidAmount: Number(d.paid_amount),
      paidCount: Number(d.paid_count),
    };
  } catch (e) {
    // Tabel belum dimigrasi -> tampilkan nol, halaman tetap terbuka.
    console.error('Wallet summary error:', e.message);
    return empty;
  }
}

// Buku mutasi (terbaru lebih dulu).
async function getLedger(userId, limit = 50) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  try {
    return await query(
      `SELECT id, kind, source, amount, balance_after, note, created_at
       FROM wallet_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      [uid, Math.max(1, Math.min(200, Number(limit) || 50))]
    );
  } catch (e) {
    return [];
  }
}

// --- Skema + backfill (dipakai config/initDb.js & config/upgradeDb.js) ---

async function ensureWalletSchema(conn) {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS user_wallets (
      user_id INT PRIMARY KEY,
      balance DECIMAL(14,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`
  );
  await conn.query(
    `CREATE TABLE IF NOT EXISTS wallet_ledger (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      kind ENUM('credit','debit') NOT NULL,
      source ENUM('fee','withdrawal','withdrawal_refund','fee_reversal','adjustment') NOT NULL,
      ref_table VARCHAR(30) NULL,
      ref_id INT NULL,
      amount DECIMAL(14,2) NOT NULL,
      balance_after DECIMAL(14,2) NOT NULL,
      note VARCHAR(255) NULL,
      actor_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ref (source, ref_table, ref_id),
      KEY user_created (user_id, id)
    ) ENGINE=InnoDB`
  );
  await conn.query(
    `CREATE TABLE IF NOT EXISTS withdrawals (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      bank_name VARCHAR(100) NULL,
      account_number VARCHAR(50) NULL,
      account_name VARCHAR(100) NULL,
      status ENUM('pending','processing','paid','rejected','cancelled') NOT NULL DEFAULT 'pending',
      admin_note VARCHAR(255) NULL,
      reject_reason VARCHAR(255) NULL,
      transfer_ref VARCHAR(100) NULL,
      proof_file VARCHAR(255) NULL,
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME NULL,
      paid_at DATETIME NULL,
      processed_by INT NULL,
      KEY user_status (user_id, status, id),
      KEY status_created (status, id)
    ) ENGINE=InnoDB`
  );
}

// Backfill: fee_logs yang sudah ada sebelum fitur dompet ini dibuat dihitung
// sebagai kredit saldo (INSERT IGNORE via kunci unik -> aman diulang).
async function backfillFeeCredits(conn) {
  const [rows] = await conn.query(
    `SELECT f.id, f.marketing_id, f.land_id, f.fee_role, f.amount
     FROM fee_logs f
     LEFT JOIN wallet_ledger l ON l.source = 'fee' AND l.ref_table = 'fee_logs' AND l.ref_id = f.id
     WHERE l.id IS NULL
     ORDER BY f.marketing_id, f.id`
  );
  let added = 0;
  for (const r of rows) {
    const amt = toNumber(r.amount);
    if (!amt || !r.marketing_id) continue;
    await conn.query('INSERT IGNORE INTO user_wallets (user_id, balance) VALUES (?, 0)', [r.marketing_id]);
    const [[w]] = await conn.query('SELECT balance FROM user_wallets WHERE user_id = ?', [r.marketing_id]);
    const after = Number(w.balance) + amt;
    await conn.query('UPDATE user_wallets SET balance = ? WHERE user_id = ?', [after, r.marketing_id]);
    await conn.query(
      `INSERT IGNORE INTO wallet_ledger (user_id, kind, source, ref_table, ref_id, amount, balance_after, note)
       VALUES (?,?,?,?,?,?,?,?)`,
      [r.marketing_id, 'credit', 'fee', 'fee_logs', r.id, amt, after,
        `Fee lahan #${r.land_id || '-'}${r.fee_role ? ' (' + r.fee_role + ')' : ''} (migrasi)`]
    );
    added += 1;
  }
  return added;
}

// Saldo dihitung ulang dari ledger (pemulih bila saldo pernah tak sinkron).
async function rebuildBalances(conn) {
  const [rows] = await conn.query(
    `SELECT user_id,
            SUM(CASE WHEN kind = 'credit' THEN amount ELSE -amount END) balance
     FROM wallet_ledger GROUP BY user_id`
  );
  for (const r of rows) {
    await conn.query('INSERT IGNORE INTO user_wallets (user_id, balance) VALUES (?, 0)', [r.user_id]);
    await conn.query('UPDATE user_wallets SET balance = ? WHERE user_id = ?', [Number(r.balance), r.user_id]);
  }
  return rows.length;
}

module.exports = {
  MIN_WITHDRAW_DEFAULT,
  minWithdraw,
  toAmount,
  toNumber,
  makeExec,
  mutate,
  creditFee,
  holdWithdrawal,
  refundWithdrawal,
  reverseFeesForLand,
  getWalletSummary,
  getLedger,
  ensureWalletSchema,
  backfillFeeCredits,
  rebuildBalances,
};
