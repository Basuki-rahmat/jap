// Adapter: panggil controller web (render / redirect+flash) dari route API
// dan ubah hasilnya menjadi data JSON — tanpa menduplikasi logika bisnis.
// Controller web tetap satu-satunya sumber kebenaran; API hanya membungkus.
function sanitize(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return value.toString('base64');
    const out = {};
    for (const k of Object.keys(value)) {
      if (typeof value[k] === 'function') continue;
      out[k] = sanitize(value[k]);
    }
    return out;
  }
  return value;
}

function appBase(req) {
  const host = typeof req.get === 'function' ? (req.get('host') || '') : '';
  const envUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (envUrl && !/localhost/.test(envUrl)) return envUrl;
  const proto = String(req.protocol || 'https');
  return proto + '://' + (host || process.env.APP_HOST || 'localhost:3000');
}

// fn: controller web (req, res, next). opts: { apiUser, body, files, query, params, req }.
// Return { type: 'render'|'redirect'|'send'|'json', ... }.
async function callWeb(fn, opts = {}) {
  const { apiUser } = opts;
  const srcReq = opts.req;
  const session = {
    user: apiUser
      ? {
          id: Number(apiUser.id),
          name: apiUser.name,
          email: apiUser.email,
          role: apiUser.role,
          referral_code: apiUser.referral_code,
          parent_id: apiUser.parent_id,
          is_head: Number(apiUser.is_head || 0),
          is_coordinator: Number(apiUser.is_coordinator || 0),
        }
      : undefined,
    flash: null,
  };
  if (srcReq && srcReq.session && srcReq.session.referralCode) {
    session.referralCode = srcReq.session.referralCode;
  }
  const hostOf = (h) => {
    try {
      if (srcReq && typeof srcReq.get === 'function') {
        const v = srcReq.get(h);
        if (v) return v;
      }
    } catch (e) {}
    return '';
  };
  const fakeReq = {
    body: opts.body || {},
    files: opts.files,
    query: opts.query || {},
    params: opts.params || {},
    session,
    protocol: (srcReq && srcReq.protocol) || 'https',
    get: (h) => {
      const k = String(h || '').toLowerCase();
      if (k === 'referer' || k === 'referrer') return '';
      if (k === 'host') return hostOf('host') || process.env.APP_HOST || 'localhost:3000';
      return hostOf(h);
    },
  };
  let settled = false;
  return new Promise((resolve, reject) => {
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fakeRes = {
      locals: { APP_URL: appBase(fakeReq) },
      redirect: (url) => done({ type: 'redirect', url, flash: session.flash }),
      render: (view, data) => done({ type: 'render', view, data: sanitize(data || {}) }),
      send: (msg) => done({ type: 'send', status: 200, message: String(msg) }),
      json: (o) => done({ type: 'json', status: 200, data: sanitize(o) }),
      status: (code) => ({
        render: (view, data) => done({ type: 'render', view, data: sanitize(data || {}), status: code }),
        send: (msg) => done({ type: 'send', status: code, message: String(msg) }),
        redirect: (url) => done({ type: 'redirect', url, flash: session.flash, status: code }),
        json: (o) => done({ type: 'json', status: code, data: sanitize(o) }),
      }),
    };
    try {
      const r = fn(fakeReq, fakeRes, (e) => {
        if (e) reject(e);
        else done({ type: 'next' });
      });
      if (r && typeof r.catch === 'function') r.catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

// Hasil redirect+flash web -> { ok, message }: sukses bila flash bertipe success
// (semua aksi admin/marketing selalu menyetel flash di kedua cabang).
function flashResult(r) {
  const flash = (r && r.flash) || {};
  return { ok: flash.type === 'success', message: flash.message || 'Selesai.' };
}

module.exports = { callWeb, flashResult, sanitize };
