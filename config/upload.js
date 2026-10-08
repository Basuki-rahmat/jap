const path = require('path');
const fs = require('fs');
const multer = require('multer');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'image/jpg'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext.toLowerCase()}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Tipe file tidak diizinkan. Gunakan JPG/PNG/WebP atau PDF.'));
  },
});

module.exports = upload.fields([
  { name: 'ktp_file', maxCount: 1 },
  { name: 'photo_1_file', maxCount: 1 },
  { name: 'photo_2_file', maxCount: 1 },
  { name: 'photo_3_file', maxCount: 1 },
  { name: 'photo_spot_file', maxCount: 1 },
  { name: 'photo_right_file', maxCount: 1 },
  { name: 'photo_left_file', maxCount: 1 },
  { name: 'photo_selfie_file', maxCount: 1 },
  { name: 'photo_maps_file', maxCount: 1 },
  { name: 'legal_doc_file', maxCount: 1 },
  { name: 'family_doc_file', maxCount: 1 },
  { name: 'sewa_doc_file', maxCount: 1 },
  { name: 'support_doc_file', maxCount: 1 },
  { name: 'sppl_file', maxCount: 1 },
]);