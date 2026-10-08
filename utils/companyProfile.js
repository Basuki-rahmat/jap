// Profil perusahaan (Pengaturan admin) — dipakai ID Card & dokumen.
// Nilai awal = data perusahaan yang diberikan pemilik; tersimpan permanen
// ke tabel settings saat admin menekan Simpan di /admin/settings.
const COMPANY_DEFAULTS = {
  company_name: 'PT. KARYA NYATA ANAK BANGSA',
  company_email: 'pertigadi@gmail.com',
  company_phone: '+62',
  company_address1: 'Jl. Hendro Suratmin Gg Kalpataru.34',
  company_address2: 'Jl. Pulau Seribu A Gg. Kalpataru No.34, Sukarame, Kec. Sukarame',
  company_city: 'Bandar Lampung',
  company_province: 'Lampung',
  company_postal: '35131',
  company_country: 'Indonesia',
  company_logo: '',
  signer_name: '',
  signer_title: '',
  signature_file: '',
};

const COMPANY_FIELDS = Object.keys(COMPANY_DEFAULTS);

async function getCompanyProfile() {
  const { getSetting } = require('./settings');
  const out = {};
  for (const f of COMPANY_FIELDS) {
    try {
      out[f] = await getSetting(f, COMPANY_DEFAULTS[f]);
    } catch (e) {
      out[f] = COMPANY_DEFAULTS[f];
    }
  }
  return out;
}

// Brand global untuk navbar/logo: nama = nama usaha SINGKAT (fallback Nama Perusahaan),
// logo = logo upload (fallback /img/logo.png).
async function getBrand() {
  const { getSetting } = require('./settings');
  let short = '';
  let full = '';
  let logo = '';
  try {
    const profile = await getCompanyProfile();
    full = (profile.company_name || '').trim();
    logo = (profile.company_logo || '').trim();
  } catch (e) { full = ''; logo = ''; }
  try {
    short = (await getSetting('business_name', '')).trim();
  } catch (e) { short = ''; }
  return { name: short || full || 'BSS', full: full || short || 'BSS', logo: logo || '/img/logo.png' };
}

module.exports = { COMPANY_DEFAULTS, COMPANY_FIELDS, getCompanyProfile, getBrand };
