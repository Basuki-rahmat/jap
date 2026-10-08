// Inti pengajuan lahan dipakai BERSAMA oleh form web (publicRoutes) dan
// API mobile (/api/v1/lahan). Validasi + insert + notifikasi identik;
// yang berbeda hanya cara merespons (render HTML vs JSON) — itu urusan pemanggil.
const { get, insert } = require('../models/db');
const {
  resolveBankName, normNik, normRek, normArea, validateOwnerFields,
  validateLahanExtra, normHarga, normLatLong, normMapsUrl,
} = require('./ownerFields');

class SubmitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizePhone62(raw) {
  let phone62 = String(raw).replace(/\D/g, '');
  if (phone62.startsWith('0')) phone62 = '62' + phone62.slice(1);
  else if (!phone62.startsWith('62')) phone62 = '62' + phone62;
  return phone62;
}

// body: field form (dimutasi: body.district dinormalisasi spt. alur web).
// files: hasil multer (req.files). sessionReferralCode: fallback referral.
// Return { landIds, referralCode, unitList }. Throw SubmitError bila invalid/gagal.
async function submitLahan({ body, files, sessionReferralCode }) {
  const {
    owner_name, phone_number, address, location_address, area_size,
    unit_type, location_type, floor_ready, has_canopy, legal_doc_type, maps_link,
    ttl, surat, shop_name, city, district, harga_sewa, lat_long, maps_url,
  } = body || {};
  // Fallback ke session agar referral tidak hilang saat pindah halaman
  const referral_code = (body && body.referral_code) || sessionReferralCode || '';
  const fail = (msg, status = 400) => { throw new SubmitError(status, msg); };

  if (!owner_name || !phone_number || !address || !location_address || !area_size || !unit_type || !location_type || !floor_ready || !has_canopy || !legal_doc_type || !maps_link
    || !ttl || !shop_name || !city || !lat_long) {
    fail('Semua kolom wajib diisi.');
  }
  // Wilayah: teks bebas dari pin/manual — simpan gabungan "Kec. X • Kel. Y".
  // Kompatibel antrean offline lama (kecamatan_name / district_manual).
  const kecBaru = String((body && body.kecamatan) || '').trim().slice(0, 100);
  const kecLama = String((body && body.kecamatan_name) || '').trim().slice(0, 100);
  const kecPakai = kecBaru || kecLama;
  let districtFinal = String((body && body.district) || '').trim().slice(0, 100);
  if (!districtFinal) {
    districtFinal = String((body && body.district_manual) || '').trim().slice(0, 100);
  }
  if (districtFinal && kecPakai && !/^kec\./i.test(districtFinal)) {
    districtFinal = ('Kec. ' + kecPakai + ' • Kel. ' + districtFinal).slice(0, 100);
  }
  // Kelurahan/kecamatan boleh kosong — simpan NULL bila tak diisi.
  body.district = districtFinal || null;
  const ownerErr2 = validateOwnerFields(body);
  if (ownerErr2) fail(ownerErr2);
  const extraErr = validateLahanExtra(body);
  if (extraErr) fail(extraErr);
  const bankName2 = resolveBankName(body);
  const accountNumber2 = normRek(body.account_number);
  const nik2 = normNik(body.nik);
  const areaSize2 = normArea(area_size);
  // Multi-unit: BSS dan/atau EVCS sekaligus — tiap jenis wajib punya slot 1-4 sendiri.
  // Legalitas otomatis per unit (BSS→PBB, EVCS→SHM).
  const unitList = [...new Set(
    [].concat(body.unit_type || []).map((u) => String(u)).filter((u) => u === 'bss_motor' || u === 'evcs_mobil')
  )];
  if (!unitList.length) fail('Pilih minimal satu jenis unit: BSS, EVCS, atau keduanya.');
  const slotFor = {};
  for (const u of unitList) {
    const key = u === 'evcs_mobil' ? 'slot_evcs' : 'slot_bss';
    const v = String((body && body[key]) || '').trim();
    if (!/^[1-4]$/.test(v)) {
      fail(`Pilih Slot 1–4 untuk ${u === 'evcs_mobil' ? 'EVCS' : 'BSS'}.`);
    }
    slotFor[u] = Number(v);
  }
  const hargaBssRaw = String((body && body.harga_sewa_bss) || '').trim();
  const hargaEvcsRaw = String((body && body.harga_sewa_evcs) || '').trim();
  const hargaBss = normHarga('bss_motor', body && body.harga_sewa_bss);
  const hargaEvcs = normHarga('evcs_mobil', body && body.harga_sewa_evcs);
  if ((hargaBssRaw && hargaBss == null) || (hargaEvcsRaw && hargaEvcs == null)) {
    fail('Harga sewa harus berupa angka (atau kosongkan bila belum tahu).');
  }
  const latLong2 = normLatLong(lat_long);
  const mapsUrl2 = normMapsUrl(maps_url);

  const fileBag = files || {};
  // Semua foto wajib kecuali dokumen pendukung (opsional).
  const requiredFiles = ['ktp_file', 'photo_1_file', 'photo_3_file',
    'photo_spot_file', 'photo_right_file', 'photo_left_file', 'photo_selfie_file', 'photo_maps_file',
    'legal_doc_file', 'family_doc_file', 'sewa_doc_file'];
  const missingFile = requiredFiles.find((f) => !fileBag[f] || !fileBag[f][0]);
  if (missingFile) {
    fail('Semua berkas wajib diunggah.');
  }
  // Kompresi server-side (jaring pengaman; client sudah mengompres duluan).
  try {
    const { compressUploads } = require('./imageCompress');
    await compressUploads(Object.values(fileBag).flat().filter(Boolean), { maxDim: 1600 });
  } catch (e) {}

  const rel = (f) => (f && f[0] ? `/uploads/${f[0].filename}` : null);
  const cols = {
    ktp_file: rel(fileBag.ktp_file),
    photo_1_file: rel(fileBag.photo_1_file),
    photo_2_file: rel(fileBag.photo_2_file),
    photo_3_file: rel(fileBag.photo_3_file),
    photo_spot_file: rel(fileBag.photo_spot_file),
    photo_right_file: rel(fileBag.photo_right_file),
    photo_left_file: rel(fileBag.photo_left_file),
    photo_selfie_file: rel(fileBag.photo_selfie_file),
    photo_maps_file: rel(fileBag.photo_maps_file),
    legal_doc_file: rel(fileBag.legal_doc_file),
    family_doc_file: rel(fileBag.family_doc_file),
    sewa_doc_file: rel(fileBag.sewa_doc_file),
    support_doc_file: rel(fileBag.support_doc_file),
  };
  const sppl_file = null; // SPPL tidak diunggah — diterbitkan otomatis setelah verifikasi lolos

  const phone62 = normalizePhone62(phone_number);

  try {
    let marketingId = null;
    if (referral_code) {
      const marketing = await get(
        'SELECT id FROM users WHERE role = ? AND referral_code = ? LIMIT 1',
        ['marketing', String(referral_code).trim()]
      );
      if (marketing) marketingId = marketing.id;
    }

    const newLandIds = [];
    for (const u of unitList) {
      const unitPrice = u === 'evcs_mobil' ? hargaEvcs : hargaBss;
      const newLandId = await insert(
      `INSERT INTO lands (marketing_id, owner_name, phone_number, bank_name, account_number, nik, ttl, surat, shop_name, city, district, harga_sewa, harga_sewa_bss, harga_sewa_evcs, address, location_address, area_size, unit_type, slot_no, location_type, floor_ready, has_canopy, legal_doc_type, maps_link, lat_long, maps_url, ktp_file, photo_1_file, photo_2_file, photo_3_file, photo_spot_file, photo_right_file, photo_left_file, photo_selfie_file, photo_maps_file, legal_doc_file, family_doc_file, sewa_doc_file, support_doc_file, sppl_file, status, fee_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
      [
        marketingId,
        String(owner_name).trim(),
        phone62,
        bankName2,
        accountNumber2,
        nik2,
        String(ttl).trim().slice(0, 100),
        String(surat).trim().slice(0, 255),
        String(shop_name).trim().slice(0, 150),
        String(city).trim().slice(0, 100),
        districtFinal || null,
        unitPrice,
        hargaBss,
        hargaEvcs,
        String(address).trim(),
        String(location_address).trim(),
        areaSize2,
        u,
        slotFor[u],
        String(location_type || '').trim(),
        floor_ready === 'ya' ? 'ya' : 'tidak',
        has_canopy === 'ya' ? 'ya' : 'tidak',
        u === 'evcs_mobil' ? 'shm' : 'pbb',
        String(maps_link || '').trim(),
        latLong2,
        mapsUrl2,
        cols.ktp_file,
        cols.photo_1_file,
        cols.photo_2_file,
        cols.photo_3_file,
        cols.photo_spot_file,
        cols.photo_right_file,
        cols.photo_left_file,
        cols.photo_selfie_file,
        cols.photo_maps_file,
        cols.legal_doc_file,
        cols.family_doc_file,
        cols.sewa_doc_file,
        cols.support_doc_file,
        sppl_file,
      ]
      );
      newLandIds.push(newLandId);
    }

    // Notifikasi interaktif: admin dapat bell, marketing referral ikut dikabari.
    // Fire-and-forget agar tak menghambat respon sukses ke penyedia lahan.
    try {
      const { notify } = require('./notify');
      const unitLbl = unitList.map((u) => (u === 'evcs_mobil' ? 'EVCS' : 'BSS')).join('+');
      notify({
        audience: 'admins',
        userIds: marketingId ? [marketingId] : [],
        title: `📥 Pengajuan lahan baru #${newLandIds.join(', #')} (${unitLbl}): ${String(owner_name).trim().slice(0, 40)}`,
        body: `${String(shop_name).trim().slice(0, 60)} • ${String(city).trim()} • ${phone62}`,
        link: '/admin/lands',
      }).catch(() => {});
    } catch (e) {}

    return { landIds: newLandIds, referralCode: referral_code || '', unitList };
  } catch (err) {
    if (err instanceof SubmitError) throw err;
    // Peta pesan error disamakan dengan handler web lama.
    if (err.message && err.message.includes('dependencies')) {
      throw new SubmitError(400, 'Semua kolom wajib diisi.');
    }
    throw new SubmitError(500, `Upload gagal: ${err.message || 'terjadi kesalahan server.'}`);
  }
}

module.exports = { submitLahan, SubmitError, normalizePhone62 };
