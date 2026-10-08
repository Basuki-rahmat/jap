(function () {
  const mapDiv = document.getElementById('locationMap');
  if (!mapDiv || typeof L === 'undefined') return;

  const linkInput = document.getElementById('maps_link');
  const statusEl = document.getElementById('locStatus');
  const btnGps = document.getElementById('btnGps');
  const btnClear = document.getElementById('btnClearMap');
  const btnOsm = document.getElementById('mapLayerOSM');
  const btnSat = document.getElementById('mapLayerSat');

  const DEFAULT = { lat: -6.200000, lng: 106.816666 }; // Jakarta
  const DIST = 13;

  const osm = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: '© Esri © OpenStreetMap contributors',
  });

  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: '© Esri Maxar',
  });

  const map = L.map(mapDiv, {
    center: [DEFAULT.lat, DEFAULT.lng],
    zoom: DIST,
    layers: [osm],
    fullscreenControl: true,
    fullscreenControlOptions: { position: 'topright' },
  });
  // Expose untuk wizard multi-step (peta di step tersembunyi perlu invalidateSize saat ditampilkan)
  window._japMap = map;
  window._japInvalidateMap = function () {
    setTimeout(function () { map.invalidateSize(); }, 60);
  };
  // Dipanggil dari input lat_long manual ala referensi: geser pin ke koordinat ketikan
  window._japSetMapPin = function (lat, lng) {
    if (!isFinite(lat) || !isFinite(lng)) return;
    place(lat, lng);
    commit(lat, lng);
  };

  let marker = null;

  function place(lat, lng) {
    if (marker) {
      marker.setLatLng([lat, lng]);
    } else {
      marker = L.marker([lat, lng], { draggable: true }).addTo(map);
      marker.on('dragend', function () {
        const p = marker.getLatLng();
        commit(p.lat, p.lng);
      });
    }
    map.setView([lat, lng], Math.max(map.getZoom(), 15));
  }

  function commit(lat, lng) {
    const ll = lat.toFixed(6) + ',' + lng.toFixed(6);
    linkInput.value = 'https://www.google.com/maps?q=' + ll;
    // Sinkron ke input koordinat terlihat ala referensi (bila ada)
    try {
      var latEl = document.getElementById('input_lat_long');
      if (latEl) {
        latEl.value = lat.toFixed(8) + ', ' + lng.toFixed(8);
        latEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) {}
    statusEl.textContent = '📍 Lokasi dipilih: ' + ll + ' (koordinat siap dikirim)';
    // Sumber kebenaran tunggal GPS + siaran ke modul kamera/editor agar watermark selalu sinkron
    try {
      window._japGps = { lat: lat, lng: lng, mapsLink: linkInput.value, updatedAt: Date.now() };
      linkInput.dispatchEvent(new Event('input', { bubbles: true }));
      linkInput.dispatchEvent(new Event('change', { bubbles: true }));
      window.dispatchEvent(new CustomEvent('jap:gps', { detail: { lat: lat, lng: lng } }));
    } catch (e) {}
    // Isi alamat otomatis (jika kolom alamat masih kosong) via reverse-geocode
    if (typeof window._japAutofillAddress === 'function') {
      try { window._japAutofillAddress(lat, lng, 'map'); } catch (e) {}
    }
  }

  map.on('click', function (e) {
    place(e.latlng.lat, e.latlng.lng);
    commit(e.latlng.lat, e.latlng.lng);
  });

  function clearPin() {
    if (marker) {
      map.removeLayer(marker);
      marker = null;
    }
    linkInput.value = '';
    statusEl.textContent = 'Pin dihapus. Klik peta atau gunakan posisi GPS Anda untuk memilih lokasi.';
    try {
      window._japGps = null;
      window.dispatchEvent(new CustomEvent('jap:gps', { detail: { lat: null, lng: null, cleared: true } }));
    } catch (e) {}
  }

  if (btnClear) btnClear.addEventListener('click', clearPin);

  // ---- Pencarian alamat (Nominatim, dibatasi Indonesia) ----
  var searchInput = document.getElementById('mapSearch');
  var suggestBox = document.getElementById('mapSuggest');
  var searchTimer = null;
  var searchSeq = 0;

  function hideSuggest() {
    if (suggestBox) { suggestBox.hidden = true; suggestBox.innerHTML = ''; }
  }
  function runSearch(q) {
    var mySeq = ++searchSeq;
    statusEl.textContent = '🔍 Mencari "' + q + '"…';
    // Via proxy server sendiri (/api/search) agar tidak kena blokir CORS / 429 Nominatim dari browser.
    fetch('/api/search?q=' + encodeURIComponent(q))
      .then(function (r) { if (!r.ok) throw new Error('geo ' + r.status); return r.json(); })
      .then(function (list) {
        if (mySeq !== searchSeq) return;
        if (!list || !list.length) {
          statusEl.textContent = 'Tidak ketemu "' + q + '" — coba kata kunci lain, GPS, atau klik manual pada peta.';
          hideSuggest();
          return;
        }
        suggestBox.innerHTML = '';
        list.forEach(function (item) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'map-suggest-item';
          b.title = item.display_name;
          b.textContent = String(item.display_name).split(',').slice(0, 4).join(',');
          b.addEventListener('click', function () {
            var lat = parseFloat(item.lat);
            var lng = parseFloat(item.lon);
            if (!isFinite(lat) || !isFinite(lng)) return;
            place(lat, lng);
            commit(lat, lng);
            searchInput.value = String(item.display_name).split(',').slice(0, 3).join(',');
            hideSuggest();
          });
          suggestBox.appendChild(b);
        });
        suggestBox.hidden = false;
        statusEl.textContent = list.length + ' hasil — klik salah satu untuk pasang pin 📍.';
      })
      .catch(function () {
        if (mySeq === searchSeq) statusEl.textContent = 'Pencarian gagal (jaringan) — coba lagi, atau gunakan GPS / klik manual pada peta.';
      });
  }
  if (searchInput && suggestBox) {
    searchInput.addEventListener('input', function () {
      var q = searchInput.value.trim();
      clearTimeout(searchTimer);
      if (q.length < 3) { hideSuggest(); return; }
      searchTimer = setTimeout(function () { runSearch(q); }, 450);
    });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault(); // jangan submit form
        var first = suggestBox.querySelector('.map-suggest-item');
        if (first) first.click();
        else if (searchInput.value.trim().length >= 3) runSearch(searchInput.value.trim());
      }
      if (e.key === 'Escape') hideSuggest();
    });
    document.addEventListener('click', function (e) {
      if (!suggestBox.hidden && !e.target.closest('.map-search-wrap')) hideSuggest();
    });
  }

  if (btnGps) {
    btnGps.addEventListener('click', function () {
      if (!navigator.geolocation) {
        statusEl.textContent = 'Browser tidak mendukung GPS.';
        return;
      }
      statusEl.textContent = 'Minta akses lokasi…';
      const opts = { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 };
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          place(pos.coords.latitude, pos.coords.longitude);
          commit(pos.coords.latitude, pos.coords.longitude);
          statusEl.textContent =
            '📍 Posisi Anda: ' + pos.coords.latitude.toFixed(6) + ',' + pos.coords.longitude.toFixed(6) +
            '. Geser pin bila perlu, atau klik lokasi pasti di peta.';
        },
        function (err) {
          statusEl.textContent =
            'Gagal mendapat lokasi GPS (' + (err.message || 'izin ditolak') +
            '). Silakan klik langsung pada peta untuk menempatkan pin 📍.';
        },
        opts
      );
    });
  }

  function setLayer(base) {
    if (base === 'sat') {
      map.removeLayer(osm);
      if (!map.hasLayer(sat)) map.addLayer(sat);
      btnOsm.classList.remove('active');
      btnSat.classList.add('active');
    } else {
      map.removeLayer(sat);
      if (!map.hasLayer(osm)) map.addLayer(osm);
      btnSat.classList.remove('active');
      btnOsm.classList.add('active');
    }
  }

  if (btnOsm) btnOsm.addEventListener('click', function () { setLayer('osm'); });
  if (btnSat) btnSat.addEventListener('click', function () { setLayer('sat'); });

  const form = mapDiv.closest('form');
  if (form) {
    form.addEventListener('submit', function (e) {
      if (!linkInput.value) {
        e.preventDefault();
        statusEl.textContent = '⚠️ Tempatkan pin 📍 di peta atau tekan "Gunakan Posisi Saya" sebelum mengirim.';
        mapDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  // Pin awal bila input sudah berisi koordinat (mode perbaikan data / draft tersimpan)
  try {
    var existing = (linkInput.value || '').match(/q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (existing) {
      var elat = parseFloat(existing[1]);
      var elng = parseFloat(existing[2]);
      if (isFinite(elat) && isFinite(elng)) {
        place(elat, elng);
        statusEl.textContent = '📍 Titik saat ini: ' + elat.toFixed(6) + ',' + elng.toFixed(6) + '. Geser pin bila perlu.';
        window._japGps = { lat: elat, lng: elng, mapsLink: linkInput.value, updatedAt: Date.now() };
      }
    }
  } catch (e) {}

  setTimeout(function () { map.invalidateSize(); }, 200);
})();
