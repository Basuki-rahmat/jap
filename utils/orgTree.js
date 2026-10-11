// Builder pohon organisasi KNAB (dipakai halaman publik + admin).
//
// - Publik  : buildOrgTree({ includeOwners: false, includeLocked: false, photoMap: null })
//             -> hanya hierarki marketing (nama, peran, unit), TANPA foto,
//             TANPA simpul penyedia. Ringkas untuk halaman depan.
// - Admin   : buildOrgTree({ includeOwners: true, includeLocked: true, photoMap: toBerkas })
//             -> lengkap semua level (termasuk terkunci + penyedia + foto privat).
//
// Return { tree, counts: { coords, heads, marketing, units, owners }, totalUnits, totalOwners }.
const { query } = require('../models/db');

function roleOf(u) {
  return (Number(u.is_coordinator) === 1 ? 'KOORDINATOR'
    : (Number(u.is_head) === 1 ? 'HEAD' : 'MARKETING'));
}

function initials(n) {
  return String(n || '?').trim().split(/\s+/)
    .map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

function ownerNodes(units) {
  const map = {};
  (units || []).forEach((l) => {
    const k = String(l.phone_number || l.owner_name);
    if (!map[k]) map[k] = { name: l.owner_name || '-', phone: l.phone_number || '', bss: 0, evcs: 0 };
    if (l.unit_type === 'evcs_mobil') map[k].evcs += 1;
    else map[k].bss += 1;
  });
  return Object.values(map);
}

async function buildOrgTree({ includeOwners = false, includeLocked = false, photoMap = null } = {}) {
  const users = await query(
    `SELECT id, name, referral_code, parent_id, is_head, is_coordinator, is_locked, photo_file
     FROM users WHERE role = 'marketing'${includeLocked ? '' : " AND (is_locked = 0 OR is_locked IS NULL)"}
     ORDER BY id ASC`
  );
  const lands = await query(
    'SELECT marketing_id, owner_name, phone_number, unit_type, slot_no FROM lands ORDER BY id ASC'
  );
  const byParent = {};
  users.forEach((u) => {
    const p = u.parent_id ? Number(u.parent_id) : 0;
    if (!byParent[p]) byParent[p] = [];
    byParent[p].push(u);
  });
  Object.values(byParent).forEach((arr) => arr.sort((a, b) => (
    Number(b.is_coordinator || 0) - Number(a.is_coordinator || 0)
    || Number(b.is_head || 0) - Number(a.is_head || 0)
    || Number(a.id) - Number(b.id)
  )));
  const landsByMkt = {};
  lands.forEach((l) => {
    if (!l.marketing_id) return;
    if (!landsByMkt[l.marketing_id]) landsByMkt[l.marketing_id] = [];
    landsByMkt[l.marketing_id].push(l);
  });
  function build(u, depth, seen) {
    if (depth > 6 || seen.has(u.id)) return null;
    seen.add(u.id);
    const units = landsByMkt[u.id] || [];
    return {
      id: u.id,
      name: u.name,
      role: roleOf(u),
      photo: photoMap ? photoMap(u.photo_file) : null,
      initials: initials(u.name),
      referral: u.referral_code || '-',
      units: units.length,
      locked: Number(u.is_locked) === 1,
      children: (byParent[u.id] || []).map((c) => build(c, depth + 1, seen)).filter(Boolean),
      owners: includeOwners ? ownerNodes(units) : [],
    };
  }
  const ids = new Set(users.map((u) => Number(u.id)));
  const roots = users
    .filter((u) => !u.parent_id || !ids.has(Number(u.parent_id)))
    .map((u) => build(u, 0, new Set()))
    .filter(Boolean);
  const totalUnits = lands.length;
  const totalOwners = new Set(lands.map((l) => String(l.phone_number || l.owner_name))).size;
  return {
    tree: roots,
    counts: {
      coords: users.filter((u) => Number(u.is_coordinator) === 1).length,
      heads: users.filter((u) => Number(u.is_head) === 1).length,
      marketing: users.length,
      units: totalUnits,
      owners: totalOwners,
    },
  };
}

module.exports = { buildOrgTree, roleOf, initials };
