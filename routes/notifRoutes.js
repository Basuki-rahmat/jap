const express = require('express');
const router = express.Router();
const { query } = require('../models/db');
const { isAuth } = require('../middlewares/authMiddleware');

router.use(isAuth);

function myId(req) {
  return Number(req.session.user && req.session.user.id) || 0;
}

// Inbox notifikasi milik sendiri
router.get('/notifikasi', async (req, res) => {
  try {
    const items = await query(
      `SELECT id, title, body, link, is_read, created_at FROM notifications
       WHERE target_user_id = ? ORDER BY id DESC LIMIT 100`,
      [myId(req)]
    );
    const back = req.session.user && req.session.user.role === 'superadmin' ? '/admin' : '/marketing';
    res.render('notifications/list', { title: 'Notifikasi', items, back });
  } catch (err) {
    console.error('Notif list error:', err);
    res.status(500).send('Terjadi kesalahan server.');
  }
});

// Badge bell: jumlah belum dibaca
router.get('/api/notif/unread', async (req, res) => {
  try {
    const rows = await query(
      'SELECT COUNT(*) total FROM notifications WHERE target_user_id = ? AND is_read = 0',
      [myId(req)]
    );
    res.json({ count: Number(rows[0] ? rows[0].total : 0) });
  } catch (err) {
    res.status(500).json({ count: 0 });
  }
});

// Pratinjau dropdown bell: 6 terbaru
router.get('/api/notif/latest', async (req, res) => {
  try {
    const items = await query(
      `SELECT id, title, body, link, is_read, created_at FROM notifications
       WHERE target_user_id = ? ORDER BY id DESC LIMIT 6`,
      [myId(req)]
    );
    res.json({ items });
  } catch (err) {
    res.status(500).json({ items: [] });
  }
});

// Tandai dibaca: satu (id) atau semua (all=1)
router.post('/api/notif/read', express.json(), async (req, res) => {
  try {
    const me = myId(req);
    if (req.body && (req.body.all === true || req.body.all === 1 || req.body.all === '1')) {
      await query('UPDATE notifications SET is_read = 1 WHERE target_user_id = ?', [me]);
    } else {
      const id = Number(req.body && req.body.id);
      if (!id) return res.status(400).json({ ok: false });
      await query('UPDATE notifications SET is_read = 1 WHERE id = ? AND target_user_id = ?', [id, me]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
