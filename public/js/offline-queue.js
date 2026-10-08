/* =========================================================
   OFFLINE-FIRST OUTBOX — Ajukan Lahan
   Skenario lapangan: HP tanpa jaringan / mode offline.
   - Submit saat offline -> disimpan di IndexedDB (teks + foto),
     bisa untuk 1–10 lokasi berbeda (maks 10 antrian).
   - Otomatis terkirim ke /submit-lahan saat online kembali
     (event online, saat halaman dibuka, tombol kirim manual).
   - Tanpa kehilangan data: berkas dibaca dari input asli
     (sudah terkompres ±200 KB), server tidak perlu diubah.
   Catatan: buka halaman sekali saat online agar file JS/CSS
   tersimpan di cache browser; GPS & watermark tetap jalan offline
   (koordinat dari HP, alamat diketik manual bila reverse-geocode
   gagal karena tidak ada jaringan).
   ========================================================= */
(function () {
  'use strict';

  var DB_NAME = 'jap-outbox';
  var STORE = 'submissions';
  var MAX_QUEUE = 10;
  var TEXT_NAMES = ['referral_code', 'owner_name', 'phone_number', 'address', 'nik', 'ttl', 'surat', 'shop_name',
'city', 'kecamatan', 'district', 'harga_sewa_bss', 'harga_sewa_evcs',
    'bank_name', 'bank_name_other', 'account_number', 'location_address', 'area_size',
      'unit_type', 'slot_bss', 'slot_evcs', 'location_type', 'floor_ready', 'has_canopy', 'legal_doc_type', 'maps_link', 'lat_long',
'maps_url'];
  var FILE_IDS = ['ktp_file', 'photo_1_file', 'photo_3_file', 'photo_spot_file', 'photo_right_file', 'photo_left_file', 'photo_selfie_file', 'photo_maps_file', 'legal_doc_file', 'family_doc_file', 'sewa_doc_file', 'support_doc_file'];
  /* ---------- IndexedDB mini-wrapper ---------- */
  var dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('Browser tidak mendukung penyimpanan offline.'));
      var req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          var st = d.createObjectStore(STORE, { keyPath: 'id' });
          st.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Gagal membuka penyimpanan offline.')); };
    });
    return dbPromise;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(STORE, mode);
        var st = t.objectStore(STORE);
        var out;
        try { out = fn(st); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error || new Error('Transaksi offline gagal.')); };
      });
    });
  }
  var Outbox = {
    add: function (entry) {
      return tx('readwrite', function (st) { return st.add(entry); });
    },
    list: function () {
      return db().then(function (d) {
        return new Promise(function (resolve, reject) {
          var items = [];
          var t = d.transaction(STORE, 'readonly');
          var idx = t.objectStore(STORE).index('createdAt');
          var cur = idx.openCursor();
          cur.onsuccess = function () {
            var c = cur.result;
            if (c) { items.push(c.value); c.continue(); }
            else resolve(items);
          };
          cur.onerror = function () { reject(cur.error || new Error('Gagal membaca antrian.')); };
        });
      });
    },
    put: function (entry) {
      return tx('readwrite', function (st) { return st.put(entry); });
    },
    del: function (id) {
      return tx('readwrite', function (st) { return st.delete(id); });
    },
    count: function () {
      return db().then(function (d) {
        return new Promise(function (resolve, reject) {
          var t = d.transaction(STORE, 'readonly');
          var q = t.objectStore(STORE).count();
          q.onsuccess = function () { resolve(q.result); };
          q.onerror = function () { reject(q.error || new Error('Gagal menghitung antrian.')); };
        });
      });
    }
  };

  /* ---------- Notifikasi ringan ---------- */
  function note(msg) {
    var t = document.getElementById('camToast');
    var m = document.getElementById('camToastMsg');
    if (t && m) {
      m.textContent = msg;
      t.hidden = false;
      setTimeout(function () { t.hidden = true; }, 3500);
    } else {
      try { alert(msg); } catch (e) {}
    }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/</g, '&lt;'); }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  /* ---------- UI: netbar + daftar antrian ---------- */
  function netBar() { return document.getElementById('netBar'); }
  function outboxBar() { return document.getElementById('outboxBar'); }

  function paintNet() {
    var bar = netBar();
    if (!bar) return;
    var online = navigator.onLine !== false;
    bar.hidden = false;
    bar.className = 'netbar ' + (online ? 'online' : 'offline');
    bar.innerHTML = online
      ? '🟢 <strong>Online</strong> — pengajuan langsung terkirim ke server.'
      : '🔴 <strong>Offline</strong> — tetap bisa isi 1–10 lokasi; data tersimpan di HP & otomatis terkirim saat online.';
  }

  function paintOutbox(items, syncing) {
    var bar = outboxBar();
    if (!bar) return;
    if (!items || !items.length) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    var h = '<div class="outbox-head">📥 <strong>' + items.length + ' pengajuan menunggu kirim</strong>'
      + (syncing ? ' <span class="muted-text">— mengirim…</span>' : '')
      + '<span style="flex:1"></span>'
      + '<button type="button" class="btn btn-outline" id="outboxSync" style="padding:6px 12px;font-size:.75rem;"' + (syncing ? ' disabled' : '') + '>🔄 Kirim sekarang</button></div>';
    h += '<div class="outbox-list">';
    items.forEach(function (it) {
      var st = it.status === 'failed'
        ? '<span class="mini no">⚠ ditolak server — cek isian</span>'
        : '<span class="mini">⏳ antri</span>';
      h += '<div class="outbox-item"><span class="grow">#' + esc(it.id.slice(-6)) + ' <strong>' + esc((it.fields && it.fields.owner_name) || '-') + '</strong>'
        + ' <span class="muted-text">' + esc(fmtTime(it.createdAt)) + (it.attempts ? ' · ' + it.attempts + 'x coba' : '') + '</span></span>'
        + st
        + ' <button type="button" class="outbox-del" data-del="' + esc(it.id) + '" title="Hapus dari HP">✕</button></div>';
    });
    h += '</div>';
    bar.innerHTML = h;
    var syncBtn = document.getElementById('outboxSync');
    if (syncBtn) syncBtn.addEventListener('click', function () { syncNow(true); });
    Array.prototype.forEach.call(bar.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Hapus pengajuan ini dari HP? (data belum terkirim akan hilang)')) return;
        Outbox.del(b.getAttribute('data-del')).then(refresh).catch(function (e) { note('Gagal menghapus: ' + (e.message || e)); });
      });
    });
  }

  function refresh() {
    paintNet();
    Outbox.list().then(function (items) { paintOutbox(items, syncing); })
      .catch(function () { paintOutbox([], syncing); });
  }

    /* ---------- Kirim 1 entri ke server ---------- */
    function postEntry(entry) {
      var fd = new FormData();
      Object.keys(entry.fields || {}).forEach(function (k) {
        var v = entry.fields[k];
        if (Array.isArray(v)) v.forEach(function (x) { fd.append(k, x); });
        else fd.append(k, v);
      });
    Object.keys(entry.files || {}).forEach(function (k) {
      var f = entry.files[k];
      if (f) fd.append(k, f, f.name || (k + '.jpg'));
    });
    return fetch('/submit-lahan', { method: 'POST', body: fd }).then(function (res) {
      if (res.ok) return { sent: true };
      if (res.status === 429 || res.status >= 500) return { retry: true, status: res.status };
      return { failed: true, status: res.status };
    });
  }

  var syncing = false;
  function syncNow(manual) {
    if (syncing) return Promise.resolve();
    if (navigator.onLine === false) {
      if (manual) note('Masih offline — ' + 'pengajuan tetap tersimpan, otomatis terkirim saat online.');
      refresh();
      return Promise.resolve();
    }
    syncing = true;
    refresh();
    return Outbox.list().then(function (items) {
      var chain = Promise.resolve();
      items.forEach(function (it) {
        chain = chain.then(function () {
          if (it.status === 'failed') return; // butuh perhatian manual, jangan ulangi otomatis
          it.attempts = (it.attempts || 0) + 1;
          return Outbox.put(it).then(function () { return postEntry(it); }).then(function (r) {
            if (r.sent) return Outbox.del(it.id);
            if (r.failed) {
              it.status = 'failed';
              it.lastError = 'HTTP ' + r.status;
              return Outbox.put(it);
            }
            it.status = 'queued'; // 429/5xx/gangguan -> coba lagi lain waktu
            return Outbox.put(it).then(function () { throw { stop: true }; });
          }).catch(function (e) {
            if (e && e.stop) throw e;
            it.status = 'queued'; // jaringan putus di tengah jalan
            return Outbox.put(it).then(function () { throw { stop: true }; });
          });
        }).catch(function (e) {
          if (!(e && e.stop)) throw e;
          // berhenti, item berikutnya dicoba pada sinkronisasi berikutnya
          var stopErr = new Error('stop');
          stopErr.stopAll = true;
          throw stopErr;
        });
      });
      return chain.catch(function (e) { if (!(e && (e.stop || e.stopAll))) throw e; });
    }).catch(function () {}).then(function () {
      syncing = false;
      refresh();
    });
  }

  /* ---------- Submit dari form: online langsung, offline antre ---------- */
    function collectForm(form) {
      var fields = {};
      TEXT_NAMES.forEach(function (n) {
          var el = form.querySelector('[name="' + n + '"]');
          if (el && el.type === 'radio') {
            var ch = form.querySelector('[name="' + n + '"]:checked');
            fields[n] = ch ? ch.value : '';
          } else if (el && el.type === 'checkbox' && n === 'unit_type') {
            fields[n] = Array.prototype.map.call(
              form.querySelectorAll('[name="' + n + '"]:checked'), function (x) { return x.value; });
          } else fields[n] = el ? el.value : '';
        });
    var files = {};
    FILE_IDS.forEach(function (id) {
      var inp = document.getElementById(id);
      if (inp && inp.files && inp.files[0]) files[id] = inp.files[0];
    });
    return { fields: fields, files: files };
  }

  function resetForNext(refCode) {
    try {
      localStorage.removeItem('jap_ajukan_draft_v1');
      localStorage.removeItem('jap_ajukan_step_v1');
    } catch (e) {}
    // referral dipertahankan agar lokasi berikutnya tetap terhubung marketing
    try {
      if (refCode) sessionStorage.setItem('jap_ref', refCode);
    } catch (e) {}
    window.location.reload();
  }

  window._japSubmitLahan = function (form) {
    var btn = form.querySelector('button[type="submit"]');
    function setBusy(b, label) {
      if (btn) { btn.disabled = b; btn.textContent = label || 'Kirim Pengajuan'; }
    }
    var data = collectForm(form);
    var fileCount = Object.keys(data.files).length;

    function showServerPage(html) {
      try {
        localStorage.removeItem('jap_ajukan_draft_v1');
        localStorage.removeItem('jap_ajukan_step_v1');
      } catch (e) {}
      document.open();
      document.write(html);
      document.close();
    }

    function queueIt(reason) {
      Outbox.count().then(function (n) {
        if (n >= MAX_QUEUE) {
          setBusy(false);
          alert('Antrian penuh (' + MAX_QUEUE + ' pengajuan). Kirim/hapus dulu antrian lama sebelum tambah lokasi baru.');
          refresh();
          return;
        }
        var entry = {
          id: 'q' + Date.now() + Math.floor(Math.random() * 1e6),
          createdAt: Date.now(),
          status: 'queued',
          attempts: 0,
          fields: data.fields,
          files: data.files
        };
        return Outbox.add(entry).then(function () {
          return Outbox.count();
        }).then(function (total) {
          var refCode = data.fields.referral_code || '';
          try {
            sessionStorage.setItem('jap_outbox_msg', reason === 'offline'
              ? '📥 Offline — tersimpan di HP (' + total + ' antrian). Lanjut isi lokasi berikutnya; otomatis terkirim saat online.'
              : '📥 Gagal terkirim — tersimpan di HP (' + total + ' antrian). Otomatis dicoba lagi saat online.');
          } catch (e) {}
          resetForNext(refCode);
        });
      }).catch(function (e) {
        setBusy(false);
        alert('Gagal menyimpan offline: ' + (e && e.message || e) + '. Jangan tutup halaman sebelum online.');
      });
    }

    if (navigator.onLine === false) {
      queueIt('offline');
      return;
    }
    setBusy(true, '⏳ Mengirim…');
      var fd = new FormData();
      Object.keys(data.fields).forEach(function (k) {
        var v = data.fields[k];
        if (Array.isArray(v)) v.forEach(function (x) { fd.append(k, x); });
        else fd.append(k, v);
      });
    Object.keys(data.files).forEach(function (k) { fd.append(k, data.files[k], data.files[k].name); });
    fetch('/submit-lahan', { method: 'POST', body: fd }).then(function (res) {
      return res.text().then(function (html) {
        if (res.ok) { showServerPage(html); return; }
        if (res.status === 429 || res.status >= 500) { queueIt('server-busy'); return; }
        showServerPage(html); // 400: server render ulang form + pesan galat (sama seperti submit biasa)
      });
    }).catch(function () {
      queueIt('offline'); // jaringan putus saat kirim
    }).then(function () {
      if (btn && btn.disabled && navigator.onLine !== false) setBusy(false);
    });
    // info berkas untuk debug ringan (tidak dikirim)
    if (window.console && window.console.debug) window.console.debug('[outbox] kirim online, berkas:', fileCount);
  };

  /* ---------- Init ---------- */
  function init() {
    paintNet();
    refresh();
    try {
      var pending = sessionStorage.getItem('jap_outbox_msg');
      if (pending) {
        sessionStorage.removeItem('jap_outbox_msg');
        setTimeout(function () { note(pending); }, 400);
      }
    } catch (e) {}
    window.addEventListener('online', function () {
      note('🟢 Online kembali — mengirim antrian…');
      syncNow(false);
    });
    window.addEventListener('offline', function () { paintNet(); });
    // sinkronisasi otomatis saat halaman dibuka (mis. kembali online lalu buka form)
    if (navigator.onLine !== false) syncNow(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
