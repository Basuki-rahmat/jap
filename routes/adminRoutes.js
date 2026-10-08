const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { isAuth, isRole } = require('../middlewares/authMiddleware');

router.use(isAuth, isRole('superadmin'));

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

router.get('/', adminController.dashboard);
router.get('/marketing', adminController.marketing);
router.post('/marketing', adminController.createMarketing);
router.post('/marketing/update', adminController.updateMarketing);
router.post('/marketing/delete', adminController.deleteMarketing);
router.post('/marketing/lock', adminController.toggleLock);
router.post('/marketing/approve', adminController.approveMarketing);
router.post('/marketing/reject', adminController.rejectMarketing);
router.post('/marketing/wa-password', adminController.waPassword);
router.get('/lands', adminController.lands);
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