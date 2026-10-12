const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const adminController = require('../controllers/adminController');
const walletController = require('../controllers/walletController');
const { isAuth, isRole } = require('../middlewares/authMiddleware');

router.use(isAuth, isRole('superadmin', 'admin'));

// Upload logo perusahaan + gambar tanda tangan (maks 2 MB) -> public/img (publik)
const imgDir = path.join(__dirname, '..', 'public', 'img');
if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
const uploadCompany = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, imgDir),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase();
      const prefix = file.fieldname === 'signature_file' ? 'signature' : 'company-logo';
      cb(null, `${prefix}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Berkas harus JPG/PNG/WebP.'));
  },
});

// Upload bukti transfer pembayaran fee (maks 5 MB, gambar/PDF) -> public/uploads
const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const uploadProof = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase();
      cb(null, `bukti-transfer-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Bukti transfer harus JPG/PNG/WebP/PDF.'));
  },
});

router.get('/', adminController.dashboard);
router.get('/struktur', adminController.struktur);
router.get('/marketing', adminController.marketing);
router.post('/marketing', adminController.createMarketing);
router.post('/marketing/update', adminController.updateMarketing);
router.post('/marketing/delete', adminController.deleteMarketing);
router.post('/marketing/lock', adminController.toggleLock);
router.post('/marketing/approve', adminController.approveMarketing);
router.post('/marketing/reject', adminController.rejectMarketing);
router.post('/marketing/wa-password', adminController.waPassword);
// Manajemen User (akun admin setara superadmin) + profil sendiri.
router.get('/users', adminController.usersPage);
router.post('/users', adminController.createUser);
router.post('/users/lock', adminController.toggleUserLock);
router.post('/users/delete', adminController.deleteUser);
router.get('/profil', adminController.showProfile);
router.post('/profil', adminController.updateProfile);
router.get('/password', adminController.showPassword);
router.post('/password', adminController.updatePassword);
router.get('/lands', adminController.lands);
// Pembayaran fee mitra: laporan pengajuan penarikan + proses/bayar/tolak.
router.get('/pembayaran', walletController.adminPage);
router.get('/pembayaran/export', walletController.adminExportCsv);
router.post(
  '/pembayaran/status',
  (req, res, next) => uploadProof.single('proof_file')(req, res, (err) => {
    if (err) {
      req.session.flash = {
        type: 'error',
        message: err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran bukti transfer melebihi 5 MB.' : `Upload bukti gagal: ${err.message}`,
      };
      return res.redirect('/admin/pembayaran');
    }
    next();
  }),
  walletController.adminAction
);
router.get('/notifikasi', adminController.notifPage);
router.post('/notifikasi', adminController.sendNotif);
router.get('/mail-log', adminController.mailLogPage);
router.post('/mail-test', adminController.mailTest);
router.get('/settings', adminController.settingsPage);
router.post(
  '/settings',
  (req, res, next) => uploadCompany.fields([
    { name: 'company_logo', maxCount: 1 },
    { name: 'signature_file', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) {
      req.session.flash = {
        type: 'error',
        message: err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran berkas melebihi 2 MB.' : `Upload gagal: ${err.message}`,
      };
      return res.redirect('/admin/settings');
    }
    next();
  }),
  adminController.saveSettings
);
router.get('/lands/:id/proposal', adminController.proposalPdf);
router.get('/lands-owner-proposal', adminController.ownerProposalPdf);
router.post('/lands/approve', adminController.approveLand);
router.post('/lands/harga', adminController.updateHarga);
router.post('/lands/sppl', adminController.regenerateSppl);
router.post('/lands/reject', adminController.rejectLand);
router.post('/lands/survey', adminController.stageFlag);
router.post('/lands/stage', adminController.stageFlag);
router.post('/lands/request-fix', adminController.requestFix);

module.exports = router;