(function () {
  const STORAGE_KEY = 'BSS-theme';
  const root = document.documentElement;

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.textContent = theme === 'dark' ? '☀️' : '🌙';
      btn.setAttribute('aria-label', theme === 'dark' ? 'Ganti ke mode terang' : 'Ganti ke mode gelap');
    }
  }

  function getSavedTheme() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return 'dark';
  }

  applyTheme(getSavedTheme());

  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('themeToggle');
    if (btn) {
      btn.addEventListener('click', function () {
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        localStorage.setItem(STORAGE_KEY, next);
        applyTheme(next);
      });
    }

    const navToggle = document.querySelector('.nav-toggle');
    const drawer = document.getElementById('drawer');
    const drawerBackdrop = document.getElementById('drawerBackdrop');
    const drawerClose = document.getElementById('drawerClose');

    function openDrawer() {
      if (drawer && drawerBackdrop && navToggle) {
        drawer.classList.add('open');
        drawerBackdrop.classList.add('show');
        navToggle.classList.add('open');
        document.body.style.overflow = 'hidden';
      }
    }

    function closeDrawer() {
      if (drawer && drawerBackdrop && navToggle) {
        drawer.classList.remove('open');
        drawerBackdrop.classList.remove('show');
        navToggle.classList.remove('open');
        document.body.style.overflow = '';
      }
    }

    if (navToggle) navToggle.addEventListener('click', openDrawer);
    if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeDrawer);
    if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
    if (drawer) {
      drawer.querySelectorAll('.drawer-link').forEach(function (link) {
        link.addEventListener('click', closeDrawer);
      });
      drawer.querySelectorAll('a[href]').forEach(function (link) {
        link.addEventListener('click', closeDrawer);
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });

    document.querySelectorAll('.btn-copy').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const text = btn.getAttribute('data-copy');
        if (!text) return;
        navigator.clipboard
          .writeText(text)
          .then(function () {
            const original = btn.textContent;
            btn.textContent = 'Tersalin!';
            setTimeout(function () {
              btn.textContent = original;
            }, 1500);
          })
          .catch(function () {
            const input = btn.previousElementSibling;
            if (input && input.select !== undefined) {
              input.select();
              document.execCommand('copy');
              btn.textContent = 'Tersalin!';
              setTimeout(function () {
                btn.textContent = 'Salin';
              }, 1500);
            }
          });
      });
    });
  });
})();