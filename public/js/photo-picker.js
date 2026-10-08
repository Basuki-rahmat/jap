  (function () {
    var FIELDS = ['ktp_file', 'photo_1_file', 'photo_3_file', 'photo_spot_file', 'photo_right_file', 'photo_left_file', 'photo_selfie_file', 'photo_maps_file', 'legal_doc_file', 'family_doc_file', 'sewa_doc_file', 'support_doc_file'];
    var store = {}; // fieldId -> [{file, url, isPdf}]
    FIELDS.forEach(function (id) { store[id] = []; });

    function realInput(id) { return document.getElementById(id); }
    function gridEl(id) { return document.getElementById(id + '_grid'); }
    function pickedEl(id) { return document.getElementById(id + '_picked'); }

    function syncReal(id) {
      var real = realInput(id);
      var list = store[id] || [];
      var sel = null;
      for (var i = 0; i < list.length; i++) { if (list[i].selected) { sel = list[i]; break; } }
      try {
        var dt = new DataTransfer();
        if (sel) dt.items.add(sel.file);
        real.files = dt.files;
      } catch (e) { /* browser lama: biarkan */ }
      var info = pickedEl(id);
      if (info) {
        if (sel) {
          info.style.display = 'block';
          info.textContent = '✓ Akan diupload: ' + sel.file.name + ' (' + Math.round(sel.file.size / 1024) + ' KB)';
        } else {
          info.style.display = 'none';
          info.textContent = '';
        }
      }
    }

    function renderGrid(id) {
      var grid = gridEl(id);
      if (!grid) return;
      grid.innerHTML = '';
      store[id].forEach(function (item, idx) {
        var cell = document.createElement('div');
        cell.className = 'shot' + (item.selected ? ' selected' : '');
        cell.title = 'Klik untuk memilih file ini';
        if (item.isPdf) {
          var pdf = document.createElement('div');
          pdf.className = 'shot-pdf';
          pdf.textContent = '📄 ' + item.file.name;
          pdf.style.cursor = 'zoom-in';
          pdf.title = 'Klik untuk pratinjau besar';
          pdf.addEventListener('click', function (ev) {
            ev.stopPropagation();
            openPreview(id, idx);
          });
          cell.appendChild(pdf);
        } else {
          var img = document.createElement('img');
          img.src = item.url;
          img.alt = item.file.name;
          img.loading = 'lazy';
          img.decoding = 'async';
          img.style.cursor = 'zoom-in';
          img.title = 'Klik untuk pratinjau besar & zoom';
          img.addEventListener('click', function (ev) {
            ev.stopPropagation();
            openPreview(id, idx);
          });
          cell.appendChild(img);
        }
        var badge = document.createElement('span');
        badge.className = 'shot-badge';
        badge.textContent = '✓ Dipilih';
        cell.appendChild(badge);
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'shot-del';
        del.textContent = '✕';
        del.title = 'Hapus';
        del.addEventListener('click', function (ev) {
          ev.stopPropagation();
          try { if (!item.isPdf && item.url) URL.revokeObjectURL(item.url); } catch (e) {}
          store[id].splice(idx, 1);
          if (item.selected && store[id].length) store[id][0].selected = true;
          syncReal(id);
          renderGrid(id);
        });
        cell.appendChild(del);
        if (!item.isPdf) {
          var edt = document.createElement('button');
          edt.type = 'button';
          edt.className = 'shot-edit';
          edt.textContent = '✏️ Edit';
          edt.title = 'Edit: tambah watermark GPS & stiker unit';
          edt.addEventListener('click', function (ev) {
            ev.stopPropagation();
            openEditor(id, idx);
          });
          cell.appendChild(edt);
        }
        var view = document.createElement('button');
        view.type = 'button';
        view.className = 'shot-view';
        view.textContent = '🔍';
        view.title = 'Pratinjau besar & zoom';
        view.addEventListener('click', function (ev) {
          ev.stopPropagation();
          openPreview(id, idx);
        });
        cell.appendChild(view);
        cell.addEventListener('click', function () {
          store[id].forEach(function (s) { s.selected = false; });
          item.selected = true;
          syncReal(id);
          renderGrid(id);
        });
        grid.appendChild(cell);
      });
    }

    // Kompres adaptif ke target ±200 KB dengan hasil tetap tajam.
    // Tahap: q0.85 → quality proporsional → kecilkan 20% per langkah + q0.72
    // sampai kena target / sisi panjang 960px (batas agar watermark tetap terbaca).
    function canvasToTargetBlob(canvas, targetBytes, done) {
      targetBytes = targetBytes || 200 * 1024;
      var best = null;
      function attempt(cv, q, next) {
        try {
          cv.toBlob(function (b) {
            if (!b) return next(null);
            if (!best || b.size < best.size) best = b;
            next(b);
          }, 'image/jpeg', q);
        } catch (e) { next(null); }
      }
      function shrink(cv, next) {
        var longEdge = Math.max(cv.width, cv.height);
        if (longEdge <= 960) {
          // Langkah akhir: coba quality 0.6 sekali bila masih di atas target
          if (best && best.size > targetBytes) attempt(cv, 0.6, function () { next(best); });
          else next(best);
          return;
        }
        var k = Math.max(960 / longEdge, 0.8);
        var c2 = document.createElement('canvas');
        c2.width = Math.max(1, Math.round(cv.width * k));
        c2.height = Math.max(1, Math.round(cv.height * k));
        try { c2.getContext('2d').drawImage(cv, 0, 0, c2.width, c2.height); }
        catch (e) { return next(best); }
        attempt(c2, 0.72, function (b) {
          if (!b) return next(best);
          if (b.size <= targetBytes || Math.max(c2.width, c2.height) <= 960) return next(best);
          shrink(c2, next);
        });
      }
      attempt(canvas, 0.85, function (b1) {
        if (b1 && b1.size <= targetBytes) return done(b1);
        var q2 = 0.8;
        if (b1) q2 = Math.min(0.8, Math.max(0.55, 0.85 * (targetBytes / b1.size)));
        attempt(canvas, q2, function (b2) {
          if (b2 && b2.size <= targetBytes) return done(b2);
          shrink(canvas, function () { done(best); });
        });
      });
    }

    function compressGalImage(f) {
      return new Promise(function (resolve) {
        var isPdf = /pdf$/i.test(f.type || '') || /\.pdf$/i.test(f.name || '');
        if (isPdf) return resolve({ file: f, isPdf: true });
        if (!/^image\//i.test(f.type || '')) return resolve({ file: f, isPdf: false });
        function toFile(blob) {
          if (!blob) return resolve({ file: f, isPdf: false });
          try {
            var nm = (f.name || 'galeri').replace(/\.[^.]+$/, '') + '-gal.jpg';
            resolve({ file: new File([blob], nm, { type: 'image/jpeg' }), isPdf: false });
          } catch (e) { resolve({ file: f, isPdf: false }); }
        }
        function drawWithBitmap(bmp) {
          try {
            var iw = bmp.width, ih = bmp.height;
            var sc = Math.min(1, 1600 / Math.max(iw, ih));
            var W = Math.max(1, Math.round(iw * sc)), H = Math.max(1, Math.round(ih * sc));
            var cv = document.createElement('canvas');
            cv.width = W; cv.height = H;
            var cx = cv.getContext('2d');
            cx.drawImage(bmp, 0, 0, W, H);
            try { if (bmp.close) bmp.close(); } catch (e) {}
            if (cv.toBlob) canvasToTargetBlob(cv, 200 * 1024, toFile);
            else resolve({ file: f, isPdf: false });
          } catch (e) { resolve({ file: f, isPdf: false }); }
        }
        try {
          if (window.createImageBitmap) {
            window.createImageBitmap(f).then(drawWithBitmap, function () { fallbackImg(); });
          } else {
            fallbackImg();
          }
        } catch (e) { resolve({ file: f, isPdf: false }); }
        function fallbackImg() {
          try {
            var url = URL.createObjectURL(f);
            var im = new Image();
            im.onload = function () {
              try { URL.revokeObjectURL(url); } catch (e) {}
              drawWithBitmap(im);
            };
            im.onerror = function () {
              try { URL.revokeObjectURL(url); } catch (e) {}
              resolve({ file: f, isPdf: false });
            };
            im.src = url;
          } catch (e) { resolve({ file: f, isPdf: false }); }
        }
      });
    }

    var galBusy = {};
    function addFiles(id, fileList, meta) {
      var hasGps = !!(meta && meta.hasGps);
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      if (galBusy[id]) return;
      galBusy[id] = true;
      var info = pickedEl(id);
      var room = Math.max(0, 10 - (store[id] ? store[id].length : 0));
      if (files.length > room) {
        alert('Maks 10 berkas per kolom. ' + (files.length - room) + ' berkas terakhir dilewati.');
        files = files.slice(0, room);
      }
      if (info) { info.style.display = 'block'; info.textContent = '⏳ Memproses ' + files.length + ' berkas… layar tetap responsif, mohon tunggu.'; }
      var i = 0, added = 0;
      function next() {
        if (i >= files.length) {
          galBusy[id] = false;
          if (added) { syncReal(id); renderGrid(id); }
          else if (info) { info.style.display = 'none'; info.textContent = ''; }
          if (!added) alert('Tidak ada berkas valid yang ditambahkan.');
          return;
        }
        var f = files[i++];
        if (f.size > 5 * 1024 * 1024) {
          compressGalImage(f).then(function (r) {
            if (r.file.size > 5 * 1024 * 1024) alert('Dilewati (melebihi 5 MB): ' + f.name);
            else pushOne(r);
            setTimeout(next, 0);
          });
        } else {
          compressGalImage(f).then(function (r) {
            pushOne(r);
            if (info) info.textContent = '⏳ Memproses ' + i + '/' + files.length + '…';
            setTimeout(next, 0);
          });
        }
      }
      function pushOne(r) {
        var url = '';
        try { url = r.isPdf ? '' : URL.createObjectURL(r.file); } catch (e) { url = ''; }
        store[id].forEach(function (s) { s.selected = false; });
        store[id].push({ file: r.file, url: url, isPdf: r.isPdf, selected: true, hasGps: hasGps });
        added++;
      }
      next();
    }

    window._japClearShots = function () {
      FIELDS.forEach(function (id) {
        (store[id] || []).forEach(function (s) { try { if (s.url) URL.revokeObjectURL(s.url); } catch (e) {} });
        store[id] = [];
        syncReal(id);
        renderGrid(id);
      });
    };

    function isAutoStickerField(id) {
      return id === 'photo_2_file'
        || id === 'photo_spot_file';
    }
    // Watermark kotak GPS (Site Name/Time/Address/Koordinat) saja, tanpa stiker unit.
    function isGpsOnlyField(id) {
      return id === 'photo_selfie_file' || id === 'photo_1_file'
        || id === 'photo_3_file' || id === 'photo_right_file' || id === 'photo_left_file';
    }
    function currentUnitKind() {
      var r = document.querySelector('input[name="unit_type"]:checked');
      var v = r ? r.value : null;
      if (!v) {
        var sel = document.getElementById('unit_type');
        v = sel ? sel.value : 'bss_motor';
      }
      return v === 'evcs_mobil' ? 'evcs' : 'bss';
    }
    function parseCoordsFromLink(str) {
      // Dukung format maps_link: ?q=lat,lng | ?query=lat,lng | "lat,lng" polos
      var s = String(str || '');
      var m = s.match(/[?&](?:q|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
        || s.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
      if (!m) return null;
      var la = parseFloat(m[1]), ln = parseFloat(m[2]);
      if (!isFinite(la) || !isFinite(ln)) return null;
      return { lat: la, lng: ln };
    }
    function getJapCoords() {
      // 1) Sumber terpusat dari peta (selalu terbaru, termasuk klik/geser pin & GPS)
      try {
        if (window._japGps && isFinite(window._japGps.lat) && isFinite(window._japGps.lng)) {
          return { lat: window._japGps.lat, lng: window._japGps.lng };
        }
      } catch (e) {}
      // 2) Fallback: parse langsung dari input (mis. draft/server mengisi tanpa event)
      var mapsEl = document.getElementById('maps_link');
      var p = mapsEl ? parseCoordsFromLink(mapsEl.value) : null;
      if (p) {
        try { window._japGps = { lat: p.lat, lng: p.lng, mapsLink: mapsEl.value, updatedAt: Date.now() }; } catch (e) {}
        return p;
      }
      return null;
    }
    function gpsInfo() {
      var c = getJapCoords();
      var coords = c ? (c.lat + ', ' + c.lng) : '';
      var addr = '', owner = '';
      // Alamat LOKASI (tahap 3) untuk watermark; fallback alamat pemilik (data lama)
      var locEl = document.getElementById('location_address');
      if (locEl) addr = locEl.value.trim();
      if (!addr) {
        var addrEl = document.getElementById('address');
        if (addrEl) addr = addrEl.value.trim();
      }
      // Fallback terakhir: cache alamat GPS bila input masih kosong
      if (!addr) {
        try { if (window._japGps && window._japGps.addr) addr = String(window._japGps.addr); } catch (e) {}
      }
      var ownerEl = document.getElementById('owner_name');
      if (ownerEl) owner = ownerEl.value.trim();
      var d = new Date();
      var pad = function (x) { return (x < 10 ? '0' : '') + x; };
      var stamp = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      return { coords: coords, addr: addr, owner: owner, stamp: stamp, lat: c ? c.lat : null, lng: c ? c.lng : null };
    }

    // ---- Format alamat terstruktur ala GeoPicker Pro (Jl./Kel./Kec.) ----
    // Dipakai semua reverse-geocode: autofill alamat + sinkron GPS + watermark.
    window._japFormatAddressNominatim = function (data) {
      try {
        if (data && data.address) {
          var addr = data.address;
          var parts = [];
          var jalan = '';
          if (addr.road) {
            var rd = String(addr.road).trim();
            // Nominatim sering sudah memberi "Jalan ..." / "Jl ..." -> jangan gandakan
            jalan = /^(jl\.?\s|jalan\s)/i.test(rd) ? rd : 'Jl. ' + rd;
          }
          else if (addr.pedestrian) jalan = addr.pedestrian;
          else if (addr.path || addr.footway) jalan = 'Gang/Jalan ' + (addr.path || addr.footway);
          if (addr.house_number) {
            if (jalan) jalan += ' No. ' + addr.house_number;
            else jalan = 'No. Rumah ' + addr.house_number;
          }
          if (jalan) parts.push(jalan);
          var poi = addr.building || addr.amenity || addr.office || addr.shop || addr.tourism || addr.historic;
          if (poi) parts.push('(' + poi + ')');
          var kel = addr.village || addr.suburb || addr.neighbourhood || addr.hamlet;
          if (kel) parts.push('Kel. ' + kel);
          var kec = addr.county || addr.district || addr.city_district;
          if (kec) parts.push('Kec. ' + String(kec).replace(/Kecamatan\s+/i, ''));
          var kota = addr.city || addr.town || addr.regency || addr.municipality;
          if (kota) parts.push(kota);
          if (addr.state) parts.push(addr.state);
          if (addr.postcode) parts.push(addr.postcode);
          if (addr.country) parts.push(addr.country);
          var out = parts.join(', ');
          if (out && out.trim().length >= 10) return out;
        }
      } catch (e) {}
      return (data && data.display_name) || '';
    };
    function structuredLabel(j) {
      var v = '';
      try {
        if (typeof window._japFormatAddressNominatim === 'function') v = window._japFormatAddressNominatim(j);
      } catch (e) { v = ''; }
      return v || (j && j.display_name) || '';
    }

    // ---- Readout + sinkron GPS untuk kamera & editor ----
    var gpsSyncBusy = false;
    function refreshGpsUI() {
      var info = gpsInfo();
      var cc = document.getElementById('camGpsCoords');
      var ca = document.getElementById('camGpsAddr');
      if (cc) cc.textContent = info.coords || 'belum ada pin — pasang pin di Tahap 3';
      if (ca) ca.textContent = (info.addr || 'alamat menyusul') + ' • ' + info.stamp;
      var ec = document.getElementById('edGpsCoords');
      var ea = document.getElementById('edGpsAddr');
      if (ec) ec.textContent = info.coords || 'belum ada pin — pasang pin di Tahap 3';
      if (ea) ea.textContent = (info.addr || 'alamat menyusul') + ' • ' + info.stamp;
      return info;
    }
    function syncGpsNow(reason) {
      // Baca ulang pin -> perbarui cache; bila alamat kosong, isi via reverse-geocode.
      // Dipakai saat buka kamera/editor & tombol "Sinkron GPS".
      var c = getJapCoords();
      refreshGpsUI();
      if (!c) {
        toast('Belum ada pin — pasang pin peta dulu');
        return null;
      }
      var addrEl = document.getElementById('location_address') || document.getElementById('address');
      if (addrEl && addrEl.value.trim()) return c; // hormati isian manual
      if (gpsSyncBusy) return c;
      gpsSyncBusy = true;
      // Via proxy server sendiri (/api/reverse) agar tidak kena blokir CORS / 429 Nominatim dari browser.
      fetch('/api/reverse?lat=' + encodeURIComponent(c.lat) + '&lon=' + encodeURIComponent(c.lng))
        .then(function (r) { if (!r.ok) throw new Error('geo ' + r.status); return r.json(); })
        .then(function (j) {
          var label = structuredLabel(j);
          if (label) {
            try { window._japGps.addr = label; } catch (e) {}
            if (addrEl && !addrEl.value.trim()) {
              addrEl.value = label;
              try { addrEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
            }
          }
        })
        .catch(function () {})
        .then(function () {
          gpsSyncBusy = false;
          refreshGpsUI();
          if (reason === 'editor' && edField) redrawEditor();
        });
      return c;
    }
    // Pin berubah (klik / geser / GPS / hapus) -> readout ikut, editor terbuka ikut redraw
    window.addEventListener('jap:gps', function () {
      refreshGpsUI();
      try {
        if (edField && edModal && !edModal.hidden) redrawEditor();
      } catch (e) {}
    });

    // ================= TOAST =================
    var toastTimer = null;
    function toast(msg) {
      var t = document.getElementById('camToast');
      var m = document.getElementById('camToastMsg');
      if (!t || !m) { try { alert(msg); } catch (e) {} return; }
      m.textContent = msg;
      t.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
    }

    // ================= KAMERA FULLSCREEN (ala GeoPicker Pro BSS) =================
    var modal = document.getElementById('camModal');
    var stage = document.getElementById('camStage');
    var video = document.getElementById('camVideo');
    var galPreview = document.getElementById('camGalPreview');
    var logoBox = document.getElementById('camLogoBox');
    var logoImg = document.getElementById('camLogoImg');
    var logoResize = document.getElementById('camLogoResize');
    var canvasOut = document.getElementById('camCanvas');
    var camTitle = document.getElementById('camTitle');
    var camBssBadge = document.getElementById('camBssBadge');
    var camStatus = document.getElementById('camStatus');
    var wmPanel = document.getElementById('camWmPanel');
    var bssSettings = document.getElementById('camBssSettings');

    var stream = null;
    var activeField = null;
    var facing = 'environment';
    var isGalleryMode = false;
    var gallerySourceImg = null;

    // State logo unit (posisi relatif stage, ala referensi)
    var unitKind = 'bss.png'; // none | bss.png | bss1.png | bss12.png | evcs1.png | evcs21.png
    function logoFileFor(kind) {
      if (!kind || kind === 'none') return null;
      if (/\.(png|jpg|jpeg)$/i.test(kind)) return '/img/' + kind;
      if (kind === 'bss') return '/img/bss.png';
      if (kind === 'evcs') return '/img/evcs1.png';
      return '/img/' + kind;
    }
    function logoKindFor(src) {
      return String(src || '').toLowerCase().indexOf('evcs') === 0 ? 'evcs' : 'bss';
    }
    function defaultLogoFile() { return currentUnitKind() === 'evcs' ? 'evcs1.png' : 'bss.png'; }
    var bssLeftPct = 37.5, bssTopPct = 30, bssScaleFactor = 1.0;
    var logoImageObj = null;
    var logoReady = false;
    var overlayCache = {};

    function setStatus(s) { if (camStatus) camStatus.textContent = s; }

    function stopCam() {
      if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} stream = null; }
      if (video) { try { video.srcObject = null; } catch (e) {} }
    }

    function startCam() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus('Browser tidak mendukung kamera dalam halaman — gunakan Galeri.');
        return;
      }
      setStatus('Mengaktifkan kamera… mohon izinkan akses kamera.');
      stopCam();
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      }).then(function (s) {
        stream = s;
        video.srcObject = s;
        video.style.transform = (facing === 'user') ? 'scaleX(-1)' : 'scaleX(1)';
        setStatus('Kamera aktif — seret logo untuk atur posisi, lalu tekan shutter. Bisa ambil beberapa kali.');
      }).catch(function (err) {
        setStatus('Kamera ditolak/tidak tersedia (' + (err.message || err.name || 'izin ditolak') + '). Butuh HTTPS/localhost, atau gunakan Galeri.');
      });
    }

    function loadOverlay(kind, cb) {
      var src = logoFileFor(kind);
      if (!src) return cb(null);
      if (overlayCache[kind]) return cb(overlayCache[kind].ok ? overlayCache[kind].img : null);
      var im = new Image();
      im.onload = function () { overlayCache[kind] = { img: im, ok: true }; cb(im); };
      im.onerror = function () { overlayCache[kind] = { img: null, ok: false }; cb(null); };
      im.src = src;
    }

    function badgeDataURL(kind, cb) {
      try {
        var cv = document.createElement('canvas');
        cv.width = 480; cv.height = 160;
        var ctx = cv.getContext('2d');
        var grad = ctx.createLinearGradient(0, 0, 480, 160);
        if (kind === 'evcs') { grad.addColorStop(0, '#0b5ed7'); grad.addColorStop(1, '#084298'); }
        else { grad.addColorStop(0, '#198754'); grad.addColorStop(1, '#0d5c34'); }
        ctx.fillStyle = grad;
        var r = 28;
        ctx.beginPath();
        ctx.moveTo(r, 0); ctx.arcTo(480, 0, 480, 160, r); ctx.arcTo(480, 160, 0, 160, r);
        ctx.arcTo(0, 160, 0, 0, r); ctx.arcTo(0, 0, 480, 0, r); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
        ctx.font = '700 52px sans-serif';
        ctx.fillText((kind === 'evcs' ? '🔌 EVCS' : '🔋 BSS'), 36, 62);
        ctx.font = '400 30px sans-serif'; ctx.globalAlpha = 0.92;
        ctx.fillText(kind === 'evcs' ? 'est. 3m x 6m' : 'min. 1m x 1,5m', 38, 116);
        ctx.globalAlpha = 1;
        cb(cv.toDataURL('image/png'));
      } catch (e) { cb(null); }
    }

    function ensureLogoImage(cb) {
      if (unitKind === 'none') { logoReady = false; logoImageObj = null; if (cb) cb(null); return; }
      loadOverlay(unitKind, function (im) {
        if (im) {
          logoImageObj = im; logoReady = true;
          try { logoImg.src = im.src; } catch (e) {}
          if (cb) cb(im);
        } else {
          badgeDataURL(logoKindFor(unitKind), function (url) {
            if (!url) { logoReady = false; if (cb) cb(null); return; }
            var fim = new Image();
            fim.onload = function () {
              logoImageObj = fim; logoReady = true;
              try { logoImg.src = url; } catch (e) {}
              if (cb) cb(fim);
            };
            fim.onerror = function () { logoReady = false; if (cb) cb(null); };
            fim.src = url;
          });
        }
      });
    }

    // Rasio asli gambar logo agar bingkai drag mepet ke objek (tanpa ruang kosong)
    function logoAspect() {
      try {
        var iw = (logoImageObj && (logoImageObj.naturalWidth || logoImageObj.width)) || 0;
        var ih = (logoImageObj && (logoImageObj.naturalHeight || logoImageObj.height)) || 0;
        if (iw > 0 && ih > 0) {
          var r = ih / iw;
          return Math.min(2.5, Math.max(0.15, r));
        }
      } catch (e) {}
      return 0.42;
    }
    // Satu-satunya acuan geometri bingkai — dipakai pratinjau & render canvas agar identik
    function logoBoxGeometry(cw, ch) {
      var base = Math.min(cw, ch) * 0.25;
      var w = Math.max(24, base * bssScaleFactor);
      var h = Math.max(12, Math.round(w * logoAspect()));
      return { w: w, h: h, x: (bssLeftPct / 100) * cw - w / 2, y: (bssTopPct / 100) * ch - h / 2 };
    }
    function updateLogoBox() {
      if (!logoBox || !stage) return;
      var cw = stage.clientWidth || 400, ch = stage.clientHeight || 400;
      var g = logoBoxGeometry(cw, ch);
      logoBox.style.width = g.w + 'px';
      logoBox.style.height = g.h + 'px';
      logoBox.style.left = g.x + 'px';
      logoBox.style.top = g.y + 'px';
      var ind = document.getElementById('camLogoScaleVal');
      if (ind) ind.textContent = Math.round(bssScaleFactor * 100) + '%';
      var slider = document.getElementById('camLogoScale');
      if (slider && document.activeElement !== slider) slider.value = Math.round(bssScaleFactor * 100);
    }

    function paintLogoButtons() {
      document.querySelectorAll('.cam-logo-btns button[data-logo]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-logo') === unitKind);
      });
      document.querySelectorAll('.cam-logo-btns button[data-glogo]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-glogo') === pendingGalLogo);
      });
    }

    function refreshUnitUI() {
      if (camBssBadge) camBssBadge.hidden = (unitKind === 'none');
      if (camBssBadge) camBssBadge.textContent = logoKindFor(unitKind) === 'evcs' ? '🔌 EVCS' : '⚡ BSS';
      if (logoBox) logoBox.hidden = (unitKind === 'none');
      if (bssSettings) bssSettings.style.display = '';
      paintLogoButtons();
      if (unitKind !== 'none') ensureLogoImage(function () { updateLogoBox(); });
      else updateLogoBox();
    }

    function resetWatermark() {
      if (isAutoStickerField(activeField || '')) {
        unitKind = defaultLogoFile();
      } else {
        unitKind = 'none';
      }
      bssLeftPct = 37.5; bssTopPct = 30; bssScaleFactor = 1.0;
      updateLogoBox();
      refreshUnitUI();
    }

    function openCam(id) {
      activeField = id;
        // Validasi ala referensi: foto lokasi / watermark-GPS wajib ada titik + alamat agar watermark akurat
        if (isAutoStickerField(id) || isGpsOnlyField(id)) {
        var mapsEl = document.getElementById('maps_link');
        var addrEl = document.getElementById('address');
        if (!mapsEl || !mapsEl.value) {
          toast('Pasang pin peta dulu (Tahap 3) agar koordinat akurat');
          setStatus('⚠️ Belum ada pin peta — stiker tetap bisa ditempel tapi koordinat "menyusul".');
        }
        if (!addrEl || !addrEl.value.trim()) {
          toast('Isi alamat dulu agar watermark lengkap');
        }
      }
      if (camTitle) camTitle.textContent = '📷 ' + id.replace(/_file$/, '').replace(/_/g, ' ');
      isGalleryMode = false;
      gallerySourceImg = null;
      if (galPreview) galPreview.hidden = true;
      if (video) video.style.display = '';
      // tampilkan modal
      if (modal) modal.hidden = false;
      document.body.style.overflow = 'hidden';
      if (wmPanel) wmPanel.hidden = true;
      resetWatermark();
      syncGpsNow('camera');
      startCam();
      setTimeout(function () { updateLogoBox(); }, 60);
    }

    function closeCam() {
      stopCam();
      if (modal) modal.hidden = true;
      if (wmPanel) wmPanel.hidden = true;
      document.body.style.overflow = '';
      isGalleryMode = false;
      gallerySourceImg = null;
      activeField = null;
    }

    // ---- Drag & resize (mouse + touch) ----
    function makeDraggable(el, getPos, setPos, ignoreEl) {
      var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      function start(e) {
        if (ignoreEl && (e.target === ignoreEl || (ignoreEl.contains && ignoreEl.contains(e.target)))) return;
        if (e.cancelable) e.preventDefault();
        dragging = true;
        var t = e.type.indexOf('touch') === 0 ? e.touches[0] : e;
        sx = t.clientX; sy = t.clientY;
        var p = getPos(); ox = p.x; oy = p.y;
        document.addEventListener('mousemove', move);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('mouseup', end);
        document.addEventListener('touchend', end);
      }
      function move(e) {
        if (!dragging) return;
        if (e.cancelable) e.preventDefault();
        var t = e.type.indexOf('touch') === 0 ? e.touches[0] : e;
        setPos(ox + (t.clientX - sx), oy + (t.clientY - sy));
      }
      function end() {
        dragging = false;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('mouseup', end);
        document.removeEventListener('touchend', end);
      }
      el.addEventListener('mousedown', start);
      el.addEventListener('touchstart', start, { passive: false });
    }

    if (logoBox && stage) {
      makeDraggable(logoBox, function () {
        return { x: parseFloat(logoBox.style.left) || 0, y: parseFloat(logoBox.style.top) || 0 };
      }, function (nx, ny) {
        var cw = stage.clientWidth || 400, ch = stage.clientHeight || 400;
        var w = parseFloat(logoBox.style.width) || 150, h = parseFloat(logoBox.style.height) || 60;
        nx = Math.max(-w * 0.3, Math.min(nx, cw - w * 0.7));
        ny = Math.max(-h * 0.3, Math.min(ny, ch - h * 0.7));
        logoBox.style.left = nx + 'px'; logoBox.style.top = ny + 'px';
        bssLeftPct = ((nx + w / 2) / cw) * 100; bssTopPct = ((ny + h / 2) / ch) * 100;
      }, logoResize);
      // Resize via handle
      (function () {
        var resizing = false, rsx = 0, rsy = 0, ow = 0;
        function rstart(e) {
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          resizing = true;
          var t = e.type.indexOf('touch') === 0 ? e.touches[0] : e;
          rsx = t.clientX; rsy = t.clientY;
          ow = parseFloat(logoBox.style.width) || 150;
          document.addEventListener('mousemove', rmove);
          document.addEventListener('touchmove', rmove, { passive: false });
          document.addEventListener('mouseup', rend);
          document.addEventListener('touchend', rend);
        }
        function rmove(e) {
          if (!resizing) return;
          if (e.cancelable) e.preventDefault();
          var t = e.type.indexOf('touch') === 0 ? e.touches[0] : e;
          var delta = Math.max(t.clientX - rsx, t.clientY - rsy);
          var cw = stage.clientWidth || 400, ch = stage.clientHeight || 400;
          var base = Math.min(cw, ch) * 0.25;
          var ns = Math.max(24, Math.min(ow + delta, Math.min(cw, ch) * 0.9));
          bssScaleFactor = ns / base;
          updateLogoBox();
        }
        function rend() {
          resizing = false;
          document.removeEventListener('mousemove', rmove);
          document.removeEventListener('touchmove', rmove);
          document.removeEventListener('mouseup', rend);
          document.removeEventListener('touchend', rend);
        }
        if (logoResize) {
          logoResize.addEventListener('mousedown', rstart);
          logoResize.addEventListener('touchstart', rstart, { passive: false });
        }
      })();
    }

    // ---- Panel controls ----
    var logoScaleInput = document.getElementById('camLogoScale');
    if (logoScaleInput) logoScaleInput.addEventListener('input', function () {
      bssScaleFactor = (parseFloat(logoScaleInput.value) || 100) / 100;
      updateLogoBox();
    });
    document.querySelectorAll('.cam-logo-btns button[data-logo]').forEach(function (b) {
      b.addEventListener('click', function () {
        unitKind = b.getAttribute('data-logo');
        refreshUnitUI();
      });
    });
    var wmToggle = document.getElementById('camWmToggle');
    if (wmToggle) wmToggle.addEventListener('click', function () {
      wmPanel.hidden = !wmPanel.hidden;
      if (!wmPanel.hidden) refreshGpsUI();
    });
    // Tab panel watermark: GPS | Logo (agar muat tanpa scroll)
    document.querySelectorAll('#camWmPanel [data-wmtab]').forEach(function (b) {
      b.addEventListener('click', function () {
        var tab = b.getAttribute('data-wmtab');
        document.querySelectorAll('#camWmPanel [data-wmtab]').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
        document.querySelectorAll('#camWmPanel [data-wmpane]').forEach(function (p) {
          p.hidden = p.getAttribute('data-wmpane') !== tab;
        });
        if (tab === 'gps') refreshGpsUI();
      });
    });
    var camGpsSyncBtn = document.getElementById('camGpsSync');
    if (camGpsSyncBtn) camGpsSyncBtn.addEventListener('click', function () {
      var c = syncGpsNow('camera');
      if (c) toast('GPS sinkron: ' + c.lat.toFixed(6) + ',' + c.lng.toFixed(6));
    });
    var wmReset = document.getElementById('camWmReset');
    if (wmReset) wmReset.addEventListener('click', function () { resetWatermark(); toast('Logo & posisi direset'); });
    var logoResetPos = document.getElementById('camLogoResetPos');
    if (logoResetPos) logoResetPos.addEventListener('click', function () {
      bssLeftPct = 37.5; bssTopPct = 30; bssScaleFactor = 1.0;
      updateLogoBox(); toast('Posisi logo direset');
    });

    // ---- Tombol kamera ----
    document.querySelectorAll('.pick-cam').forEach(function (btn) {
      btn.addEventListener('click', function () { openCam(btn.getAttribute('data-target')); });
    });
    var camClose = document.getElementById('camClose');
    var camCancelFull = document.getElementById('camCancelFull');
    if (camClose) camClose.addEventListener('click', closeCam);
    if (camCancelFull) camCancelFull.addEventListener('click', closeCam);
    var camFlip = document.getElementById('camFlip');
    if (camFlip) camFlip.addEventListener('click', function () {
      if (isGalleryMode) return;
      facing = (facing === 'environment') ? 'user' : 'environment';
      toast('Kamera ' + (facing === 'user' ? 'depan' : 'belakang'));
      startCam();
    });

    // ================= GALERI VIA PREVIEW (ala referensi) =================
    var pendingGalField = null;
    var pendingGalLogo = 'bss.png';
    var galModal = document.getElementById('galLogoModal');
    function openGalChooser(fieldId) {
      pendingGalField = fieldId;
      pendingGalLogo = isAutoStickerField(fieldId) ? defaultLogoFile() : 'none';
      paintLogoButtons();
      // sinkron tombol galeri
      document.querySelectorAll('.cam-logo-btns button[data-glogo]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-glogo') === pendingGalLogo);
      });
      if (galModal) galModal.hidden = false;
      document.body.style.overflow = 'hidden';
    }
    function closeGalChooser() {
      if (galModal) galModal.hidden = true;
      if (!modal || modal.hidden) document.body.style.overflow = '';
      pendingGalField = null;
    }
    document.querySelectorAll('.cam-logo-btns button[data-glogo]').forEach(function (b) {
      b.addEventListener('click', function () {
        pendingGalLogo = b.getAttribute('data-glogo');
        document.querySelectorAll('.cam-logo-btns button[data-glogo]').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
      });
    });
    var galClose = document.getElementById('galLogoClose');
    var galCancel = document.getElementById('galLogoCancel');
    var galNext = document.getElementById('galLogoNext');
    if (galClose) galClose.addEventListener('click', closeGalChooser);
    if (galCancel) galCancel.addEventListener('click', closeGalChooser);
    if (galNext) galNext.addEventListener('click', function () {
      if (!pendingGalField) return;
      var hid = document.getElementById(pendingGalField + '_gal');
      if (galModal) galModal.hidden = true;
      if (hid) hid.click();
      else closeGalChooser();
    });

      // Alihkan tombol galeri: foto lokasi/watermark-GPS -> chooser + preview; dokumen -> langsung picker
      document.querySelectorAll('.pick-gal').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-target');
          if (isAutoStickerField(id) || isGpsOnlyField(id)) openGalChooser(id);
          else {
            var gal = document.getElementById(id + '_gal');
            if (gal) gal.click();
          }
        });
      });
    document.querySelectorAll('.pick-gal-input').forEach(function (gal) {
      gal.addEventListener('change', function () {
        var id = gal.id.replace(/_gal$/, '');
        var picked = Array.prototype.slice.call(gal.files || []);
        gal.value = '';
        if (!picked.length) { if (pendingGalField) closeGalChooser(); return; }
          // Jika foto lokasi / GPS-only & hanya 1 gambar -> buka editor preview ala referensi
          // (GPS-only selalu logo 'none': watermark kotak GPS saja, tanpa stiker unit)
          if ((isAutoStickerField(id) || isGpsOnlyField(id)) && picked.length === 1 && /^image\//i.test(picked[0].type || '')) {
            var logoChoice = isGpsOnlyField(id) ? 'none' : ((id === pendingGalField) ? pendingGalLogo : defaultLogoFile());
          openGalleryPreview(id, picked[0], logoChoice);
          pendingGalField = null;
          if (galModal) galModal.hidden = true;
        } else {
          if (galModal && !galModal.hidden) closeGalChooser();
          addFiles(id, picked);
        }
      });
    });

    function openGalleryPreview(fieldId, file, logoChoice) {
      activeField = fieldId;
      unitKind = (/^(none|bss\.png|bss1\.png|bss12\.png|evcs1\.png|evcs21\.png)$/i.test(logoChoice || '')) ? logoChoice : defaultLogoFile();
      isGalleryMode = true;
      stopCam();
      var url = '';
      try { url = URL.createObjectURL(file); } catch (e) {}
      var im = new Image();
      im.onload = function () {
        gallerySourceImg = im;
        if (galPreview) { galPreview.src = url; galPreview.hidden = false; }
        if (video) video.style.display = 'none';
        if (camTitle) camTitle.textContent = '🖼️ Edit galeri — ' + fieldId.replace(/_file$/, '').replace(/_/g, ' ');
        if (modal) modal.hidden = false;
        document.body.style.overflow = 'hidden';
        if (wmPanel) wmPanel.hidden = true;
        // default watermark mengikuti owner bila foto lokasi
        resetWatermark();
        unitKind = logoChoice;
        refreshUnitUI();
        syncGpsNow('camera');
        setStatus('Atur posisi logo, lalu tekan shutter untuk proses watermark permanen.');
        setTimeout(function () { updateLogoBox(); }, 60);
      };
      im.onerror = function () {
        addFiles(fieldId, [file]);
      };
      im.src = url;
    }

    // ================= RENDER AKHIR =================
    function roundRectPath(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    function drawBadge(ctx, kind, x, y, w, h) {
      var grad = ctx.createLinearGradient(x, y, x + w, y + h);
      if (kind === 'evcs') { grad.addColorStop(0, '#0b5ed7'); grad.addColorStop(1, '#084298'); }
      else { grad.addColorStop(0, '#198754'); grad.addColorStop(1, '#0d5c34'); }
      roundRectPath(ctx, x, y, w, h, Math.min(18, h * 0.22));
      ctx.fillStyle = grad; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
      var fs1 = Math.max(14, h * 0.34);
      ctx.font = '700 ' + fs1 + 'px sans-serif';
      ctx.fillText((kind === 'evcs' ? '🔌 EVCS MOBIL' : '🔋 BSS MOTOR'), x + h * 0.28, y + h * 0.36);
      ctx.font = Math.max(11, h * 0.24) + 'px sans-serif';
      ctx.globalAlpha = 0.9;
      ctx.fillText(kind === 'evcs' ? 'est. 3m x 6m' : 'min. 1m x 1,5m', x + h * 0.28, y + h * 0.74);
      ctx.globalAlpha = 1;
    }
    function drawLogoOnCanvas(ctx, canvas, imgEl) {
      var g = logoBoxGeometry(canvas.width, canvas.height);
      if (!imgEl) { drawBadge(ctx, logoKindFor(unitKind), g.x, g.y, g.w, g.h); return; }
      try {
        // Rasio boks == rasio gambar (satu acuan), jadi fill tepat tanpa distorsi
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 20;
        ctx.drawImage(imgEl, g.x, g.y, g.w, g.h);
        ctx.restore();
      } catch (e) {
        drawBadge(ctx, logoKindFor(unitKind), g.x, g.y, g.w, g.h);
      }
    }
    function getWrappedLines(ctx, text, maxWidth) {
      var words = String(text || '').split(' ');
      var line = '', lines = [];
      for (var n = 0; n < words.length; n++) {
        var t = line + words[n] + ' ';
        if (ctx.measureText(t).width > maxWidth && n > 0) { lines.push(line.trim()); line = words[n] + ' '; }
        else line = t;
      }
      if (line.trim()) lines.push(line.trim());
      return lines.length ? lines : ['-'];
    }
    function drawWatermarkFullWidth(ctx, canvas) {
      var cw = canvas.width, ch = canvas.height;
      var info = gpsInfo();
      var pad = Math.round(Math.min(cw, ch) * 0.03);
      // Panel info bawah
      var now = new Date();
      var timeStr = now.toLocaleDateString('id-ID', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) +
        ' ' + now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/\./g, ':');
      var coordStr = info.coords || 'koordinat menyusul';
      var siteStr = info.owner || '-';
      var addrStr = info.addr || 'alamat menyusul';
      var baseFs = Math.round(Math.min(cw, ch) * 0.025);
      var labelW = Math.round(baseFs * 6.5);
      var lh = Math.round(baseFs * 1.4);
      var padIn = Math.round(baseFs * 0.6);
      ctx.font = '600 ' + baseFs + 'px sans-serif';
      var maxW = cw - 2 * pad - labelW - 2 * padIn;
      var addrLines = getWrappedLines(ctx, addrStr, maxW).slice(0, 6);
      var nameH = Math.round(baseFs * 2.2), timeH = Math.round(baseFs * 2.2);
      var addrH = Math.max(Math.round(baseFs * 2.5), addrLines.length * lh + padIn);
      var coordH = Math.round(baseFs * 2.2);
      var panelH = nameH + timeH + addrH + coordH;
      var panelY = ch - panelH - pad;
      ctx.save();
      ctx.fillStyle = 'rgba(10,15,15,0.80)';
      ctx.fillRect(pad, panelY, cw - 2 * pad, panelH);
      ctx.strokeStyle = '#57d89b';
      ctx.lineWidth = Math.max(2, Math.round(baseFs * 0.08));
      ctx.strokeRect(pad, panelY, cw - 2 * pad, panelH);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(87,216,155,0.70)';
      ctx.beginPath();
      ctx.moveTo(pad + labelW, panelY); ctx.lineTo(pad + labelW, panelY + panelH);
      var dy = panelY + nameH;
      [timeH, addrH].forEach(function (rh) {
        ctx.moveTo(pad, dy); ctx.lineTo(cw - pad, dy); dy += rh;
      });
      ctx.moveTo(pad, dy); ctx.lineTo(cw - pad, dy);
      ctx.stroke();
      var valX = pad + labelW + padIn;
      function drawLabel(label, y, rh) {
        ctx.font = '700 ' + baseFs + 'px sans-serif';
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(label, pad + padIn, y + rh / 2);
      }
      function drawValue(val, y, rh) {
        ctx.font = '700 ' + baseFs + 'px sans-serif';
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        var t = String(val);
        var mw = cw - 2 * pad - labelW - 2 * padIn;
        while (t.length > 1 && ctx.measureText(t).width > mw) t = t.slice(0, -1);
        if (t !== String(val)) t = t.trimEnd() + '…';
        ctx.fillText(t, valX, y + rh / 2);
      }
      var ry = panelY;
      drawLabel('Site Name :', ry, nameH); drawValue(siteStr, ry, nameH); ry += nameH;
      drawLabel('Time :', ry, timeH); drawValue(timeStr, ry, timeH); ry += timeH;
      drawLabel('Address :', ry, addrH);
      ctx.font = '600 ' + baseFs + 'px sans-serif';
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      addrLines.forEach(function (ln, ix) { ctx.fillText(ln, valX, ry + padIn / 2 + ix * lh); });
      ry += addrH;
      drawLabel('Koordinat :', ry, coordH); drawValue(coordStr, ry, coordH);
      ctx.restore();
    }

    var pendingResultBlob = null;
    var pendingHasGps = false;
    var camShotBtn = document.getElementById('camShot');
    var resultModal = document.getElementById('camResultModal');
    var resultImg = document.getElementById('camResultImg');
    var resultStatus = document.getElementById('camResultStatus');
    if (camShotBtn) camShotBtn.addEventListener('click', function () {
      try {
        if (!canvasOut) throw new Error('Canvas tidak ditemukan.');
        var ctx = canvasOut.getContext('2d');
        if (isGalleryMode && gallerySourceImg) {
          var gw = gallerySourceImg.naturalWidth || gallerySourceImg.width || 1280;
          var gh = gallerySourceImg.naturalHeight || gallerySourceImg.height || 720;
          var sc0 = Math.min(1, 1920 / Math.max(gw, gh));
          canvasOut.width = Math.round(gw * sc0);
          canvasOut.height = Math.round(gh * sc0);
          ctx.drawImage(gallerySourceImg, 0, 0, canvasOut.width, canvasOut.height);
        } else {
          if (!video || !video.videoWidth) { setStatus('Kamera belum siap — tunggu sebentar lalu coba lagi.'); return; }
          var vw = video.videoWidth, vh = video.videoHeight;
          var sc = Math.min(1, 1920 / Math.max(vw, vh));
          canvasOut.width = Math.round(vw * sc);
          canvasOut.height = Math.round(vh * sc);
          ctx.save();
          if (facing === 'user') { ctx.translate(canvasOut.width, 0); ctx.scale(-1, 1); }
          ctx.drawImage(video, 0, 0, canvasOut.width, canvasOut.height);
          ctx.restore();
        }
        var auto = isAutoStickerField(activeField || '');
        var gpsOnly = isGpsOnlyField(activeField || '');
        if (unitKind !== 'none' && (auto || isGalleryMode)) {
          if (logoReady && logoImageObj) drawLogoOnCanvas(ctx, canvasOut, logoImageObj);
          else {
            loadOverlay(unitKind, function (im) {
              if (im) { logoImageObj = im; logoReady = true; }
            });
            drawLogoOnCanvas(ctx, canvasOut, logoImageObj);
          }
        }
        if (auto || isGalleryMode || gpsOnly) drawWatermarkFullWidth(ctx, canvasOut);
        pendingHasGps = (auto || isGalleryMode || gpsOnly);
        // tampilkan hasil
        var url = canvasOut.toDataURL('image/jpeg', 0.9);
        if (resultImg) resultImg.src = url;
        if (resultModal) resultModal.hidden = false;
        if (resultStatus) {
          var gi = gpsInfo();
          resultStatus.textContent = gi.coords
            ? 'Sudah ber-watermark permanen (' + gi.coords + '). Simpan untuk masuk ke grid.'
            : 'Sudah ber-watermark permanen (koordinat menyusul — pasang pin peta agar akurat). Simpan untuk masuk ke grid.';
        }
        pendingResultBlob = null;
        if (canvasOut.toBlob) canvasToTargetBlob(canvasOut, 200 * 1024, function (b) { pendingResultBlob = b; });
        // hentikan preview live agar hemat baterai, tapi jangan tutup modal utama
        if (!isGalleryMode) stopCam();
        // sembunyikan panel agar hasil terlihat
        if (wmPanel) wmPanel.hidden = true;
      } catch (err) {
        setStatus('Gagal memproses foto: ' + (err.message || err));
      }
    });

    function hideResult() { if (resultModal) resultModal.hidden = true; }
    var resultClose = document.getElementById('camResultClose');
    var retakeBtn = document.getElementById('camRetake');
    var saveGridBtn = document.getElementById('camSaveGrid');
    if (resultClose) resultClose.addEventListener('click', function () {
      hideResult();
      if (!isGalleryMode && modal && !modal.hidden) startCam();
    });
    if (retakeBtn) retakeBtn.addEventListener('click', function () {
      hideResult();
      if (!isGalleryMode) startCam();
      setStatus('Ulangi — atur lagi posisi lalu tekan shutter.');
    });
    if (saveGridBtn) saveGridBtn.addEventListener('click', function () {
      if (!activeField) { hideResult(); return; }
      function pushBlob(blob) {
        if (!blob) { toast('Gagal menyimpan — coba lagi'); return; }
        var fname = 'kamera-' + activeField + '-' + Date.now() + '.jpg';
        var file;
        try { file = new File([blob], fname, { type: 'image/jpeg' }); }
        catch (e) {
          // fallback browser lama
          file = blob; file.name = fname;
        }
        addFiles(activeField, [file], { hasGps: pendingHasGps });
        hideResult();
        var wasGal = isGalleryMode;
        closeCam();
        toast(wasGal ? 'Foto galeri + watermark masuk grid ✓' : 'Foto + stiker otomatis masuk grid ✓');
      }
      if (pendingResultBlob) pushBlob(pendingResultBlob);
      else if (canvasOut && canvasOut.toBlob) canvasToTargetBlob(canvasOut, 200 * 1024, pushBlob);
    });

    window.addEventListener('resize', function () { updateLogoBox(); });
    if (stage) {
      // cegah scroll saat interaksi touch di stage
      stage.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
    }

    // ---- Editor watermark legacy: GPS + stiker unit (BSS/EVCS) ----
    var edModal = document.getElementById('edModal');
    var edCanvas = document.getElementById('edCanvas');
    var edGps = document.getElementById('edGps');
    var edUnit = document.getElementById('edUnit');
    var edPos = document.getElementById('edPos');
    var edSave = document.getElementById('edSave');
    var edCancel = document.getElementById('edCancel');
    var edClose = document.getElementById('edClose');
    var edStatus = document.getElementById('edStatus');
    var edField = null, edIdx = -1, edImg = null, edImgUrl = '';

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawBadgeLegacy(ctx, kind, x, y, w, h) {
      var label = kind === 'evcs' ? 'EVCS MOBIL' : 'BSS MOTOR';
      var sub = kind === 'evcs' ? 'est. 3m x 6m' : 'min. 1m x 1,5m';
      var grad = ctx.createLinearGradient(x, y, x + w, y + h);
      if (kind === 'evcs') { grad.addColorStop(0, '#0b5ed7'); grad.addColorStop(1, '#084298'); }
      else { grad.addColorStop(0, '#198754'); grad.addColorStop(1, '#0d5c34'); }
      roundRect(ctx, x, y, w, h, Math.min(18, h * 0.22));
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      var fs1 = Math.max(14, h * 0.34);
      ctx.font = '700 ' + fs1 + 'px sans-serif';
      ctx.fillText((kind === 'evcs' ? '🔌 ' : '🔋 ') + label, x + h * 0.28, y + h * 0.36);
      ctx.font = Math.max(11, h * 0.24) + 'px sans-serif';
      ctx.globalAlpha = 0.9;
      ctx.fillText(sub, x + h * 0.28, y + h * 0.74);
      ctx.globalAlpha = 1;
    }

    function redrawEditor() {
      if (!edImg) return;
      var iw = edImg.naturalWidth || edImg.width, ih = edImg.naturalHeight || edImg.height;
      if (!iw || !ih) return;
      var scale = Math.min(1, 1600 / Math.max(iw, ih));
      var W = Math.round(iw * scale), H = Math.round(ih * scale);
      edCanvas.width = W; edCanvas.height = H;
      var ctx = edCanvas.getContext('2d');
      ctx.drawImage(edImg, 0, 0, W, H);
      var info = gpsInfo();
      var wantGps = edGps && edGps.checked;
      var unit = edUnit ? edUnit.value : 'none';
      var pos = edPos ? edPos.value : 'tr';

      function paintOverlays() {
        if (unit !== 'none') {
          var bw = Math.round(W * 0.34), bh = Math.round(bw * 0.30);
          var bx = 12, by = 12;
          if (pos === 'tr') { bx = W - bw - 12; by = 12; }
          if (pos === 'bl') { bx = 12; by = H - bh - 12 - (wantGps ? Math.round(H * 0.16) : 0); }
          if (pos === 'br') { bx = W - bw - 12; by = H - bh - 12 - (wantGps ? Math.round(H * 0.16) : 0); }
          loadOverlay(unit, function (im) {
            if (im) {
              var ratio = im.height / im.width;
              var dw = bw, dh = Math.round(bw * ratio);
              if (dh > H * 0.3) { dh = Math.round(H * 0.3); dw = Math.round(dh / ratio); }
              ctx.drawImage(im, bx, by, dw, dh);
            } else {
              drawBadgeLegacy(ctx, unit, bx, by, bw, bh);
            }
          });
        }
        if (wantGps) {
          var barH = Math.max(58, Math.round(H * 0.15));
          ctx.fillStyle = 'rgba(0,0,0,0.65)';
          ctx.fillRect(0, H - barH, W, barH);
          ctx.fillStyle = '#fff';
          ctx.textBaseline = 'alphabetic';
          var p = 12, fs = Math.max(13, Math.round(barH * 0.24));
          ctx.font = '700 ' + fs + 'px sans-serif';
          ctx.fillText('📍 ' + (info.coords || 'koordinat menyusul'), p, H - barH + fs + 8);
          ctx.font = fs - 1 + 'px sans-serif';
          ctx.globalAlpha = 0.92;
          var addr = info.addr ? info.addr.slice(0, 90) : 'alamat menyusul';
          ctx.fillText(addr, p, H - barH + fs * 2 + 12);
          ctx.fillText('⏰ ' + info.stamp, p, H - 10);
          ctx.globalAlpha = 1;
        }
      }
      paintOverlays();
      // Peringatan bila GPS dicentang di atas foto yang sudah ber-GPS
      try {
        var cur = (edField && store[edField] && store[edField][edIdx]) || null;
        if (!edSaving && edStatus && wantGps && cur && cur.hasGps) {
          edStatus.textContent = '⚠️ Foto sudah ber-GPS — pratinjau menumpuk. Matikan Watermark GPS bila tidak ingin dobel.';
        }
      } catch (e) {}
    }

    function openEditor(id, idx) {
      var item = store[id] && store[id][idx];
      if (!item || item.isPdf) return;
      try {
        if (item.hasGps) {
          // Foto sudah ber-panel GPS permanen (hasil kamera) -> matikan default agar tidak menumpuk
          if (edGps) edGps.checked = false;
          if (edUnit && typeof currentUnitKind === 'function' && isAutoStickerField(id)) edUnit.value = currentUnitKind();
          else if (edUnit) edUnit.value = 'none';
        } else if (typeof isAutoStickerField === 'function' && isAutoStickerField(id)) {
          if (edGps) edGps.checked = true;
          if (edUnit && typeof currentUnitKind === 'function') edUnit.value = currentUnitKind();
        } else {
          if (edGps) edGps.checked = false;
          if (edUnit) edUnit.value = 'none';
        }
      } catch (e) {}
      edField = id; edIdx = idx;
      // Jangan revoke URL yang masih dipakai item (buka ulang tanpa simpan = URL sama)
      if (edImgUrl && edImgUrl !== item.url) { try { URL.revokeObjectURL(edImgUrl); } catch (e) {} }
      edImgUrl = item.url;
      edImg = null;
      if (edSave) { edSave.disabled = true; }
      if (edStatus) edStatus.textContent = '⏳ Memuat gambar…';
      if (edModal) edModal.hidden = false;
      document.body.style.overflow = 'hidden';
      syncGpsNow('editor');
      var im = new Image();
      im.onload = function () {
        edImg = im;
        redrawEditor();
        var gi = gpsInfo();
        if (edSave) { edSave.disabled = false; }
        if (edStatus) {
          edStatus.textContent = item.hasGps
            ? 'Foto sudah ber-panel GPS permanen — Watermark GPS dimatikan agar tidak menumpuk. Nyalakan hanya bila ingin menimpa (' + (gi.coords || 'belum ada pin') + ').'
            : 'Pratinjau langsung — GPS yang akan ditempel: ' + (gi.coords || 'belum ada pin') + '.';
        }
        refreshGpsUI();
      };
      im.onerror = function () { if (edStatus) edStatus.textContent = 'Gagal memuat gambar untuk diedit.'; };
      im.src = edImgUrl;
    }
    function closeEditor() {
      if (edModal) edModal.hidden = true;
      if (!modal || modal.hidden) document.body.style.overflow = '';
      edField = null; edIdx = -1; edImg = null; edImgUrl = '';
    }
    var edGpsSyncBtn = document.getElementById('edGpsSync');
    if (edGpsSyncBtn) edGpsSyncBtn.addEventListener('click', function () {
      var c = syncGpsNow('editor');
      if (c) {
        if (edStatus) edStatus.textContent = 'GPS sinkron: ' + c.lat.toFixed(6) + ',' + c.lng.toFixed(6) + ' — pratinjau diperbarui.';
        toast('GPS sinkron ✓ pratinjau diperbarui');
      }
    });
    if (edGps) edGps.addEventListener('change', redrawEditor);
    if (edUnit) edUnit.addEventListener('change', redrawEditor);
    if (edPos) edPos.addEventListener('change', redrawEditor);
    if (edCancel) edCancel.addEventListener('click', closeEditor);
    if (edClose) edClose.addEventListener('click', closeEditor);
    if (edModal) edModal.addEventListener('click', function (e) { if (e.target === edModal) closeEditor(); });
    var edSaving = false;
    if (edSave) edSave.addEventListener('click', function () {
      if (edSaving) return;
      if (!edImg || !edField || edIdx < 0) return;
      var wantGps = edGps && edGps.checked;
      var unit = edUnit ? edUnit.value : 'none';
      if (!wantGps && unit === 'none') {
        if (edStatus) edStatus.textContent = 'Tidak ada perubahan — file asli dipertahankan.';
        setTimeout(closeEditor, 350);
        return;
      }
      edSaving = true;
      edSave.disabled = true;
      if (edStatus) edStatus.textContent = '⏳ Menyimpan…';
      redrawEditor();
      function overlayReady(cb) {
        if (unit === 'none') return cb();
        try {
          loadOverlay(unit, function () { setTimeout(cb, 60); });
          setTimeout(cb, 1500);
        } catch (e) { cb(); }
      }
      var done = false;
      function finish() {
        if (done) return; done = true;
        canvasToTargetBlob(edCanvas, 200 * 1024, function (blob) {
          edSaving = false;
          if (edSave) edSave.disabled = false;
          if (!blob) { if (edStatus) edStatus.textContent = 'Gagal menyimpan — coba lagi.'; return; }
          if (blob.size > 5 * 1024 * 1024) { if (edStatus) edStatus.textContent = 'Hasil edit melebihi 5 MB — coba matikan salah satu watermark.'; return; }
          var old = store[edField][edIdx];
          var fname = ((old && old.file.name ? old.file.name : 'foto').replace(/\.[^.]+$/, '') || 'foto') + '-wm.jpg';
          var file = new File([blob], fname, { type: 'image/jpeg' });
          try { if (old.url) URL.revokeObjectURL(old.url); } catch (e) {}
          var wasSel = old.selected;
          var wasGps = !!(old.hasGps || wantGps); // panel lama tetap ada bila tidak ditimpa
          var url = '';
          try { url = URL.createObjectURL(file); } catch (e) {}
          store[edField][edIdx] = { file: file, url: url, isPdf: false, selected: wasSel, hasGps: wasGps };
          syncReal(edField);
          renderGrid(edField);
          closeEditor();
        });
      }
      overlayReady(finish);
    });

    // ================= PRATINJAU GRID + POPUP ZOOM =================
    var pvBox = document.getElementById('shotBox');
    var pvImg = document.getElementById('shotImg');
    var pvFrame = document.getElementById('shotFrame');
    var pvCap = document.getElementById('shotCap');
    var pvZoomIn = document.getElementById('shotZoomIn');
    var pvZoomOut = document.getElementById('shotZoomOut');
    var pvZoomReset = document.getElementById('shotZoomReset');
    var pvClose = document.getElementById('shotClose');
    var pvPick = document.getElementById('shotPick');
    var pvPickClose = document.getElementById('shotPickClose');
    var pvZoom = 1, pvPdfUrl = '', pvId = null, pvIdx = -1;
    function pvSetZoom(z) {
      if (!pvImg) return;
      pvZoom = Math.min(4, Math.max(1, z));
      pvImg.style.transform = pvZoom > 1 ? 'scale(' + pvZoom + ')' : '';
    }
    function pvShowControls(isImg) {
      [pvZoomIn, pvZoomOut, pvZoomReset].forEach(function (b) { if (b) b.hidden = !isImg; });
    }
    function openPreview(id, idx) {
      if (!pvBox || !pvImg || !pvFrame) return;
      var item = store[id] && store[id][idx];
      if (!item) return;
      var src = item.isPdf ? '' : item.url;
      if (item.isPdf) {
        try {
          if (pvPdfUrl) URL.revokeObjectURL(pvPdfUrl);
          pvPdfUrl = '';
        } catch (e) {}
        try { pvPdfUrl = URL.createObjectURL(item.file); src = pvPdfUrl; } catch (e) { src = ''; }
      }
      if (!src) { toast('Pratinjau tidak tersedia untuk berkas ini'); return; }
      pvSetZoom(1);
      if (pvCap) pvCap.textContent = item.file.name || '';
      pvId = id; pvIdx = idx;
      if (pvPick) pvPick.textContent = item.selected ? '✓ Sudah dipilih' : '✓ Pilih foto ini';
      if (item.isPdf) {
        pvImg.hidden = true; pvImg.src = '';
        pvFrame.hidden = false; pvFrame.src = src;
        pvShowControls(false);
      } else {
        pvFrame.hidden = true; pvFrame.src = '';
        pvImg.hidden = false; pvImg.src = src;
        pvShowControls(true);
      }
      pvBox.hidden = false;
      document.body.style.overflow = 'hidden';
    }
    function closePreview() {
      if (!pvBox || pvBox.hidden) return;
      pvBox.hidden = true;
      try { pvImg.src = ''; } catch (e) {}
      try { pvFrame.src = ''; } catch (e) {}
      try { if (pvPdfUrl) URL.revokeObjectURL(pvPdfUrl); } catch (e) {}
      pvPdfUrl = '';
      pvSetZoom(1);
      pvId = null; pvIdx = -1;
      var anyCamOpen = (modal && !modal.hidden) || (edModal && !edModal.hidden);
      if (!anyCamOpen) document.body.style.overflow = '';
    }
    if (pvClose) pvClose.addEventListener('click', closePreview);
    if (pvPickClose) pvPickClose.addEventListener('click', closePreview);
    if (pvPick) pvPick.addEventListener('click', function () {
      if (pvId === null || pvIdx < 0 || !store[pvId] || !store[pvId][pvIdx]) return;
      store[pvId].forEach(function (s) { s.selected = false; });
      store[pvId][pvIdx].selected = true;
      syncReal(pvId);
      renderGrid(pvId);
      closePreview();
      toast('Foto dipilih ✓ akan diupload');
    });
    if (pvBox) pvBox.addEventListener('click', function (e) { if (e.target === pvBox) closePreview(); });
    if (pvImg) pvImg.addEventListener('click', function () { pvSetZoom(pvZoom > 1 ? 1 : 2); });
    if (pvZoomIn) pvZoomIn.addEventListener('click', function (e) { e.stopPropagation(); pvSetZoom(pvZoom + 0.25); });
    if (pvZoomOut) pvZoomOut.addEventListener('click', function (e) { e.stopPropagation(); pvSetZoom(pvZoom - 0.25); });
    if (pvZoomReset) pvZoomReset.addEventListener('click', function (e) { e.stopPropagation(); pvSetZoom(1); });
    var pvStage = pvBox ? pvBox.querySelector('.shot-lb-stage') : null;
    if (pvStage) pvStage.addEventListener('wheel', function (e) {
      if (pvImg.hidden) return;
      e.preventDefault();
      pvSetZoom(pvZoom + (e.deltaY < 0 ? 0.15 : -0.15));
    }, { passive: false });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && pvBox && !pvBox.hidden) closePreview();
    });
  })();
