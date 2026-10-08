const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const marketingController = require('../controllers/marketingController');
const { isAuth, isRole } = require('../middlewares/authMiddleware');

router.use(isAuth, isRole('marketing'));

// Upload mandiri: foto diri + foto KTP (gambar saja, maks 5 MB per berkas)
const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const uploadProfil = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, `mkt-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Foto harus JPG/PNG/WebP.'));
  },
});

router.get('/', marketingController.dashboard);
router.post('/lands/request-fix', marketingController.requestFix);
router.get('/jaringan', marketingController.network);
router.get('/tambah', marketingController.showTambah);
router.post('/tambah', marketingController.createDownline);
router.get('/profil', marketingController.showProfile);
router.post(
  '/profil',
  (req, res, next) => uploadProfil.fields([
    { name: 'photo_file', maxCount: 1 },
    { name: 'ktp_file', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) {
      req.session.flash = {
        type: 'error',
        message: err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran foto melebihi 5 MB.' : `Upload gagal: ${err.message}`,
      };
      return res.redirect('/marketing/profil');
    }
    next();
  }),
  marketingController.updateProfile
);
router.get('/password', marketingController.showPassword);
router.post('/password', marketingController.updatePassword);
router.get('/id-card', marketingController.idCard);
router.get('/surat-tugas', marketingController.suratTugas);

module.exports = router;