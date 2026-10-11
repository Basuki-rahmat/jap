// Helper URL berkas privat.
//
// DB menyimpan path fisik lama berbentuk `/uploads/<nama-file>`.
// Path itu TIDAK boleh muncul di HTML/JSON/Network (folder uploads tidak
// terekspos). Fungsi ini mengubahnya menjadi URL privat `/berkas/<nama-file>`
// yang wajib login + cek kepemilikan (lihat routes/fileRoutes.js).
//
// - toBerkas('/uploads/abc.jpg') -> '/berkas/abc.jpg'
// - toBerkas('/img/logo.png')    -> '/img/logo.png' (aset publik, dibiarkan)
// - toBerkas(null/'')            -> '' (aman dipakai di template)
function toBerkas(p) {
  if (p == null) return '';
  const s = String(p);
  if (s.indexOf('/uploads/') !== 0) return s;
  const name = s.slice('/uploads/'.length).split(/[?#]/)[0];
  // Tolak traversal / karakter aneh — kembalikan string kosong agar
  // template tidak merender link rusak.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png|webp|pdf)$/i.test(name)) return '';
  return '/berkas/' + name;
}

function isUploadPath(p) {
  return typeof p === 'string' && p.indexOf('/uploads/') === 0;
}

module.exports = { toBerkas, isUploadPath };
