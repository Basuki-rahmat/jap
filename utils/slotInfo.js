/**
 * Penomoran slot multi-titik per pemilik.
 * Aturan: 1 baris lands = 1 unit (1 BSS atau 1 EVCS).
 * 1 pemilik (disamakan via phone_number yang sudah dinormalisasi 62xxx)
 * bisa punya N titik: BSS-1..BSS-n dan EVCS-1..EVCS-n secara terpisah,
 * plus nomor urut global (Unit ke-X dari Y).
 *
 * buildSlotMap(rows): rows = [{ id, phone_number, unit_type, slot_no }]
 *   diurut id ASC. Mengembalikan { [id]: { seq, total, typeSeq, typeTotal, typeCode } }
 *   typeCode: 'BSS' | 'EVCS'
 *   Bila slot_no manual (1-4) terisi, ia dipakai sebagai typeSeq
 *   (pilihan pengaju); bila kosong, dipakai nomor urut otomatis.
 */

function typeCodeOf(unitType) {
  return unitType === 'evcs_mobil' ? 'EVCS' : 'BSS';
}

function buildSlotMap(rows) {
  const sorted = (rows || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
  const totals = {};
  const typeTotals = {};
  sorted.forEach((r) => {
    const ph = String(r.phone_number || '');
    const tc = typeCodeOf(r.unit_type);
    totals[ph] = (totals[ph] || 0) + 1;
    const k = `${ph}||${tc}`;
    typeTotals[k] = (typeTotals[k] || 0) + 1;
  });
  const seen = {};
  const typeSeen = {};
  const map = {};
  sorted.forEach((r) => {
    const ph = String(r.phone_number || '');
    const tc = typeCodeOf(r.unit_type);
    const k = `${ph}||${tc}`;
    seen[ph] = (seen[ph] || 0) + 1;
    typeSeen[k] = (typeSeen[k] || 0) + 1;
    const manual = Number(r.slot_no);
    const useManual = Number.isInteger(manual) && manual >= 1 && manual <= 4;
    map[r.id] = {
      seq: seen[ph],
      total: totals[ph] || 0,
      typeSeq: useManual ? manual : typeSeen[k],
      typeTotal: typeTotals[k] || 0,
      typeCode: tc,
    };
  });
  return map;
}

// Label ringkas: "BSS-2/4" atau "EVCS-1/1"
function shortLabel(slot) {
  if (!slot) return '-';
  return `${slot.typeCode}-${slot.typeSeq}/${slot.typeTotal}`;
}

// Label panjang: "Slot BSS-2 dari 4 (Unit ke-3 dari 5)"
function longLabel(slot) {
  if (!slot) return '';
  const base = `Slot ${slot.typeCode}-${slot.typeSeq} dari ${slot.typeTotal}`;
  if (slot.total > 1 && slot.total !== slot.typeTotal) {
    return `${base} • Unit ke-${slot.seq} dari ${slot.total}`;
  }
  return base;
}

module.exports = { typeCodeOf, buildSlotMap, shortLabel, longLabel };
