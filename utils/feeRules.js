// Matriks fee berjenjang per lahan yang di-approve.
// Model: nilai KOTOR berantai. Koordinator terima Koor, teruskan Head ke bawah.
//   Koor terima G_koor, teruskan G_head -> bersih koor = G_koor - G_head
//   Head terima G_head, teruskan G_mkt  -> bersih head = G_head - G_mkt
//   Marketing terima G_mkt (bersih, tidak meneruskan)
// Total keluar perusahaan = kotor peran tertinggi yang hadir dalam rantai.
//
// ATURAN DISTRIBUSI MENURUT SIAPA YANG MENGAJUKAN LAHAN (lihat buildPayouts):
//   (a) Pengaju marketing biasa
//       marketing dapat porsi marketing; porsi itu MENGURANGI porsi head,
//       dan porsi head mengurangi porsi koordinator (rantai berantai).
//   (b) Pengaju head marketing
//       head memegang seluruh porsi head (slot marketing dipegang pengaju,
//       tidak dibayar ke orang lain), porsi head mengurangi koordinator.
//   (c) Pengaju koordinator
//       fee TIDAK didistribusikan ke bawah — koordinator memegang kotor
//       penuh; head dan marketing tidak mendapat fee.
// Peran yang tidak ada di rantai: slotnya diserap peran tertinggi berikutnya
// (mis. head tidak ada -> koordinator menerima kotor K - porsi marketing),
// sehingga total keluar selalu = kotor peran tertinggi yang hadir.
// Lahan TANPA referral (marketing_id NULL): fee Rp 0 — hanya ditandai admin.
const { query, get } = require('../models/db');
const { getSetting, setSetting } = require('./settings');

const WILAYAH_LIST = [
  ['dki_jakarta', 'DKI Jakarta'],
  ['bogor', 'Bogor'],
  ['depok', 'Depok'],
  ['tangerang', 'Tangerang'],
  ['bekasi', 'Bekasi'],
];

const DEFAULT_FEE_MATRIX = {
  bss: {
    dki_jakarta: { koordinator: 900000, head: 500000, marketing: 300000 },
    bogor: { koordinator: 700000, head: 450000, marketing: 300000 },
    depok: { koordinator: 700000, head: 450000, marketing: 300000 },
    tangerang: { koordinator: 700000, head: 450000, marketing: 300000 },
    bekasi: { koordinator: 700000, head: 450000, marketing: 300000 },
  },
  evcs: {
    dki_jakarta: { koordinator: 1500000, head: 800000, marketing: 500000 },
    bogor: { koordinator: 1200000, head: 750000, marketing: 500000 },
    depok: { koordinator: 1200000, head: 750000, marketing: 500000 },
    tangerang: { koordinator: 1200000, head: 750000, marketing: 500000 },
    bekasi: { koordinator: 1200000, head: 750000, marketing: 500000 },
  },
};

const FEE_KEY = 'fee_matrix_v1';

function toInt(v, fallback = 0) {
  let s = String(v == null ? '' : v).trim();
  s = s.replace(/\./g, '').replace(/,/g, '.');
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Normalisasi lands.city -> salah satu key wilayah.
// Tak dikenal -> { key:'bogor', isFallback:true } (grup non-DKI).
function normalizeWilayah(city) {
  const s = String(city || '').toLowerCase();
  if (/jakarta|\bdki\b/.test(s)) return { key: 'dki_jakarta', label: 'DKI Jakarta', isFallback: false };
  if (/bogor/.test(s)) return { key: 'bogor', label: 'Bogor', isFallback: false };
  if (/depok/.test(s)) return { key: 'depok', label: 'Depok', isFallback: false };
  if (/tangerang|tanggerang/.test(s)) return { key: 'tangerang', label: 'Tangerang', isFallback: false };
  if (/bekasi/.test(s)) return { key: 'bekasi', label: 'Bekasi', isFallback: false };
  return { key: 'bogor', label: 'Bogor (default)', isFallback: true };
}

function typeKeyOf(unitType) {
  return unitType === 'evcs_mobil' ? 'evcs' : 'bss';
}

// Sanitasi matriks dari settings (pastikan 2x5x3 integer >= 0).
function sanitizeMatrix(raw) {
  const out = JSON.parse(JSON.stringify(DEFAULT_FEE_MATRIX));
  if (!raw || typeof raw !== 'object') return out;
  for (const t of ['bss', 'evcs']) {
    if (!raw[t] || typeof raw[t] !== 'object') continue;
    for (const [wk] of WILAYAH_LIST) {
      const cell = raw[t][wk];
      if (!cell || typeof cell !== 'object') continue;
      out[t][wk] = {
        koordinator: toInt(cell.koordinator, out[t][wk].koordinator),
        head: toInt(cell.head, out[t][wk].head),
        marketing: toInt(cell.marketing, out[t][wk].marketing),
      };
    }
  }
  return out;
}

async function getFeeMatrix() {
  // Sumber utama: tabel fee_rules. Fallback: settings lama (fee_matrix_v1), lalu default.
  try {
    const rows = await query('SELECT unit_type, wilayah, koordinator, head, marketing FROM fee_rules');
    if (rows && rows.length) {
      const raw = { bss: {}, evcs: {} };
      rows.forEach((r) => {
        if ((r.unit_type === 'bss' || r.unit_type === 'evcs') && r.wilayah) {
          raw[r.unit_type][r.wilayah] = { koordinator: r.koordinator, head: r.head, marketing: r.marketing };
        }
      });
      return sanitizeMatrix(raw);
    }
  } catch (e) {
    // Tabel belum ada (belum migrasi) -> lanjut ke fallback di bawah.
  }
  try {
    const raw = await getSetting(FEE_KEY, '');
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_FEE_MATRIX));
    return sanitizeMatrix(JSON.parse(raw));
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_FEE_MATRIX));
  }
}

async function saveFeeMatrix(matrix) {
  const clean = sanitizeMatrix(matrix);
  // Validasi berantai: Koor >= Head >= Marketing (agar bersih tidak minus).
  const errors = [];
  for (const t of ['bss', 'evcs']) {
    for (const [wk, lbl] of WILAYAH_LIST) {
      const c = clean[t][wk];
      if (!(c.koordinator >= c.head && c.head >= c.marketing)) {
        errors.push(`${t.toUpperCase()} ${lbl}: harus Koor ≥ Head ≥ Marketing (dapat ${c.koordinator}/${c.head}/${c.marketing})`);
      }
    }
  }
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.code = 'FEE_CHAIN_INVALID';
    err.details = errors;
    throw err;
  }
  // Tulis ke tabel fee_rules (sumber utama) + settings lama (kompatibilitas).
  try {
    for (const t of ['bss', 'evcs']) {
      for (const [wk] of WILAYAH_LIST) {
        const c = clean[t][wk];
        await query(
          'INSERT INTO fee_rules (unit_type, wilayah, koordinator, head, marketing) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE koordinator=VALUES(koordinator), head=VALUES(head), marketing=VALUES(marketing)',
          [t, wk, c.koordinator, c.head, c.marketing]
        );
      }
    }
  } catch (e) {
    // Tabel belum ada -> hanya settings yang tersimpan (approve tetap jalan via fallback).
    console.error('Save fee_rules table error:', e.message);
  }
  await setSetting(FEE_KEY, JSON.stringify(clean));
  return clean;
}

// Nilai kotor untuk satu lahan.
function getGrossFor(matrix, city, unitType) {
  const m = matrix || DEFAULT_FEE_MATRIX;
  const w = normalizeWilayah(city);
  const t = typeKeyOf(unitType);
  const cell = (m[t] && m[t][w.key]) || DEFAULT_FEE_MATRIX[t][w.key];
  return { type: t, wilayah: w.key, wilayahLabel: w.label, isFallback: w.isFallback, gross: { ...cell } };
}

// Pecah kotor -> bersih per peran.
function splitNet(gross) {
  const gk = toInt(gross.koordinator), gh = toInt(gross.head), gm = toInt(gross.marketing);
  return {
    koordinator: Math.max(0, gk - gh),
    head: Math.max(0, gh - gm),
    marketing: Math.max(0, gm),
  };
}

// Telusuri parent_id ke atas (maks 6 level, anti-loop).
// Return { headId, koorId } (null bila tak ditemukan).
async function resolveChain(marketingId, getUser) {
  const fetchUser = getUser || ((id) => get('SELECT id, parent_id, is_head, is_coordinator FROM users WHERE id = ? LIMIT 1', [id]));
  let headId = null, koorId = null;
  const seen = new Set();
  let cur = await fetchUser(marketingId);
  // Jika pengaju sendiri head/koor, ia merangkap porsi itu.
  if (cur) {
    if (Number(cur.is_coordinator) === 1 && koorId == null) koorId = cur.id;
    if (Number(cur.is_head) === 1 && headId == null) headId = cur.id;
  }
  let nextParent = cur ? cur.parent_id : null;
  let depth = 0;
  while (nextParent && depth < 6 && !seen.has(Number(nextParent))) {
    seen.add(Number(nextParent));
    const u = await fetchUser(nextParent);
    if (!u) break;
    if (headId == null && Number(u.is_head) === 1) headId = u.id;
    if (koorId == null && Number(u.is_coordinator) === 1) koorId = u.id;
    nextParent = u.parent_id;
    depth += 1;
    if (headId != null && koorId != null) break;
  }
  return { headId, koorId };
}

// Susun daftar payout (bersih + kotor) untuk satu lahan, sesuai aturan
// distribusi berdasarkan siapa yang mengajukan (lihat komentar atas file):
//   (a) marketing biasa   -> mkt = G_mkt, head = G_head - G_mkt, koor = G_koor - G_head
//   (b) head yang mengaju -> head memegang seluruh porsi head, koor = G_koor - G_head
//   (c) koor yang mengaju -> koor memegang kotor penuh, bawahnya tidak dapat
function buildPayouts({ marketingId, headId, koorId, gross }) {
  const gk = toInt(gross.koordinator);
  const gh = toInt(gross.head);
  const gm = toInt(gross.marketing);
  const net = splitNet(gross);
  const rows = [];
  const netHead = Math.max(0, gh - gm);
  // Head tidak ada di rantai -> slot head diserap koordinator (total keluar
  // tetap kotor koor, bukan menyisakan porsi yang tidak terbayar).
  const netKoor = (hasHead) => (hasHead ? Math.max(0, gk - gh) : Math.max(0, gk - gm));

  if (koorId && marketingId && koorId === marketingId) {
    // (c) Pengaju koordinator: fee tidak didistribusikan ke bawah.
    rows.push({ userId: koorId, role: 'koordinator', net: gk, gross: gk });
  } else if (headId && marketingId && headId === marketingId) {
    // (b) Pengaju head: baris marketing hanya jejak audit (porsinya dipegang
    //     pengaju juga), sehingga total yang diterima = G_head.
    rows.push({ userId: headId, role: 'marketing', net: gm, gross: gm });
    rows.push({ userId: headId, role: 'head', net: netHead, gross: gh });
    if (koorId) rows.push({ userId: koorId, role: 'koordinator', net: netKoor(true), gross: gk });
  } else {
    // (a) Pengaju marketing biasa.
    if (marketingId) rows.push({ userId: marketingId, role: 'marketing', net: gm, gross: gm });
    if (headId) rows.push({ userId: headId, role: 'head', net: netHead, gross: gh });
    if (koorId) rows.push({ userId: koorId, role: 'koordinator', net: netKoor(Boolean(headId)), gross: gk });
  }

  // Total keluar = jumlah bersih peran yang hadir.
  const total = rows.reduce((a, r) => a + r.net, 0);
  // Kotor tertinggi yang hadir (untuk lands.fee_amount / display).
  // Tanpa penerima (lahan tanpa referral) -> fee memang 0.
  let topGross = 0;
  if (koorId) topGross = gk;
  else if (headId) topGross = gh;
  else if (marketingId) topGross = gm;
  return { rows: rows.filter((r) => r.net >= 0), net, total, topGross };
}

module.exports = {
  WILAYAH_LIST,
  DEFAULT_FEE_MATRIX,
  FEE_KEY,
  normalizeWilayah,
  typeKeyOf,
  sanitizeMatrix,
  getFeeMatrix,
  saveFeeMatrix,
  getGrossFor,
  splitNet,
  resolveChain,
  buildPayouts,
};
