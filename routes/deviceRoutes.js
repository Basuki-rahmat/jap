const express = require('express');
const router = express.Router();
const deviceController = require('../controllers/deviceController');
const { isAuth } = require('../middlewares/authMiddleware');

router.use(isAuth);

router.get('/perangkat', deviceController.showDevices);
router.post('/perangkat/hapus', express.urlencoded({ extended: true }), deviceController.forgetDevice);
router.post('/perangkat/lupakan-lainnya', express.urlencoded({ extended: true }), deviceController.forgetOthers);

module.exports = router;
