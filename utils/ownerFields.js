// Aturan validasi bersama (satu sumber): dipakai pengajuan lahan (publik),
// kelola marketing (admin), dan profil marketing mandiri.
// Semua query tetap memakai placeholder (?); fungsi ini hanya normalisasi + validasi.
const BANKS = [
  'BCA', 'BRI', 'Mandiri', 'BNI', 'BTN', 'BSI',
  'CIMB Niaga', 'Danamon', 'Permata', 'Panin', 'OCBC', 'Maybank',
];

function resolveBankName(body) {
  const pick = String((body && body.bank_name) || '').trim();
  if (pick === 'Lainnya') return String((body && body.bank_name_other) || '').trim().slice(0, 100);
  if (BANKS.includes(pick)) return pick;
  return '';
}

function normNik(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length === 16 ? d : null;
}

function normRek(v) {
  const d = String(v == null ? '' : v).replace(/[\s.-]/g, '').replace(/\D/g, '');
  return d.length >= 6 && d.length <= 20 ? d : null;
}

function normArea(v) {
  const s = String(v == null ? '' : v).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!isFinite(n) || n <= 0 || n > 1000000) return null;
  return String(n);
}

function normalizePhone62(input) {
  let p = String(input || '').replace(/\D/g, '');
  if (!p) return '';
  if (p.startsWith('0')) p = '62' + p.slice(1);
  else if (!p.startsWith('62')) p = '62' + p;
  return p;
}

// Validasi paket Tahap-1 pengajuan lahan (bank + rek + NIK + luas).
function validateOwnerFields(body) {
  const bank = resolveBankName(body);
  if (!bank) return 'Nama bank wajib dipilih (pilih "Lainnya" lalu tulis manual bila tidak ada di daftar).';
  if (!normRek(body && body.account_number)) return 'No. rekening harus 6–20 digit angka.';
  if (!normNik(body && body.nik)) return 'NIK harus tepat 16 digit angka sesuai KTP.';
  if (!normArea(body && body.area_size)) return 'Luas lahan harus angka lebih dari 0 (maks 1.000.000 m²). Contoh: 500 atau 250.5';
  return null;
}

// Validasi data rekening + identitas marketing (admin & profil mandiri).
function validateMarketingIdentity(body) {
  const bank = resolveBankName(body);
  if (!bank) return 'Nama bank wajib dipilih (pilih "Lainnya" lalu tulis manual bila tidak ada di daftar).';
  if (!normRek(body && body.account_number)) return 'No. rekening harus 6–20 digit angka.';
  if (!normNik(body && body.nik)) return 'NIK / No. KTP harus tepat 16 digit angka.';
  return null;
}

// ---- Field ala referensi Japripay System.html ----
// Validasi Nama Toko: larangan RUMAH (kecuali "Rumah Makan"), RMH, RM
// (kecuali diikuti nama makanan), dan PRIBADI.
const SHOP_FOOD_KEYWORDS = [
  'makan', 'padang', 'ayam', 'soto', 'bakso', 'nasi', 'goreng',
  'seafood', 'steak', 'pizza', 'pasta', 'mie', 'bebek', 'ikan',
  'udang', 'cumi', 'pecel', 'rawon', 'rendang', 'sate', 'gado',
];

function checkShopName(text) {
  const lower = String(text == null ? '' : text).toLowerCase().trim();
  if (!lower) return { forbidden: false };
  if (lower.includes('pribadi')) return { forbidden: true, reason: 'pribadi' };
  if (lower.includes('rumah')) {
    if (lower.includes('rumah makan')) return { forbidden: false };
    return { forbidden: true, reason: 'rumah' };
  }
  if (lower.includes('rmh')) return { forbidden: true, reason: 'rmh' };
  if (lower.includes('rm')) {
    const words = lower.split(/\s+/);
    let isFoodContext = false;
    let isStandaloneRm = false;
    for (let i = 0; i < words.length; i++) {
      if (words[i] === 'rm') {
        const next = words[i + 1] || '';
        if (SHOP_FOOD_KEYWORDS.some((f) => next.includes(f))) isFoodContext = true;
        else isStandaloneRm = true;
      }
    }
    if (isFoodContext) return { forbidden: false };
    if (isStandaloneRm || lower === 'rm') return { forbidden: true, reason: 'rm' };
    if (lower.startsWith('rm ') && !isFoodContext) return { forbidden: true, reason: 'rm' };
  }
  return { forbidden: false };
}

function validateShopName(body) {
  const v = String((body && body.shop_name) || '').trim();
  if (!v) return 'Nama toko wajib diisi.';
  if (v.length > 150) return 'Nama toko maksimal 150 karakter.';
  const r = checkShopName(v);
  if (r.forbidden) {
    if (r.reason === 'pribadi') return 'Nama toko tidak boleh mengandung kata "PRIBADI".';
    if (r.reason === 'rumah') return 'Kata "RUMAH" hanya boleh untuk "Rumah Makan".';
    if (r.reason === 'rmh') return '"RMH" tidak diperbolehkan. Gunakan "RM" untuk Rumah Makan.';
    return '"RM" harus diikuti nama makanan (contoh: RM Padang, RM Ayam).';
  }
  return null;
}

function normHarga(unitType, v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  if (!d) return null;
  const n = Number(d);
  if (!isFinite(n) || n <= 0) return null;
  return n;
}

function validateHargaSewa(body) {
  const raw = String((body && body.harga_sewa) == null ? '' : body.harga_sewa).trim();
  if (!raw) return null; // boleh kosong — nantinya diisi admin
  const n = normHarga(body && body.unit_type, raw);
  if (n == null) return 'Harga sewa harus angka (atau kosongkan bila belum tahu).';
  return null;
}

function normLatLong(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(s)) return null;
  return s;
}

function normMapsUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (!/^https?:\/\/.+/i.test(s)) return null;
  return s.slice(0, 1000);
}

// Validasi paket field referensi (TTL, surat, toko, kota, kelurahan, harga, koordinat, link maps).
function validateLahanExtra(body) {
  const ttl = String((body && body.ttl) || '').trim();
  if (!ttl) return 'Tempat, tanggal lahir wajib diisi (contoh: Bali, 12 Jan 1990).';
  if (ttl.length > 100) return 'Tempat, tanggal lahir maksimal 100 karakter.';
  const surat = String((body && body.surat) || '').trim();
  if (!surat) return null; // boleh kosong
  if (surat.length > 255) return 'Surat maksimal 255 karakter.';
  const shopErr = validateShopName(body);
  if (shopErr) return shopErr;
  const city = String((body && body.city) || '').trim();
  if (!city) return 'Kota wajib diisi.';
  if (city.length > 100) return 'Kota maksimal 100 karakter.';
  const district = String((body && body.district) || '').trim();
  if (district.length > 100) return 'Kelurahan maksimal 100 karakter.';
  const hargaErr = validateHargaSewa(body);
  if (hargaErr) return hargaErr;
  if (!normLatLong(body && body.lat_long)) return 'Format koordinat belum benar. Contoh: -6.200000, 106.816666.';
  const mapsUrlRaw = String((body && body.maps_url) == null ? '' : body.maps_url).trim();
  if (mapsUrlRaw && !normMapsUrl(mapsUrlRaw)) return 'Link Google Maps tidak valid (harus http(s)://...).';
  return null;
}

module.exports = {
  BANKS,
  resolveBankName,
  normNik,
  normRek,
  normArea,
  normalizePhone62,
  validateOwnerFields,
  validateMarketingIdentity,
  SHOP_FOOD_KEYWORDS,
  checkShopName,
  validateShopName,
  normHarga,
  validateHargaSewa,
  normLatLong,
  normMapsUrl,
  validateLahanExtra,
};
