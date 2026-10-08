// Nomor ID anggota ala referensi ID Card (JPN-BSS-999734 = 6 digit akhir No. HP).
// Deterministik dari No. WhatsApp; fallback ke ID user bila WA belum diisi.
function memberId(user) {
  const digits = String((user && user.whatsapp) || '').replace(/\D/g, '');
  if (digits.length >= 6) return 'JPN-BSS-' + digits.slice(-6);
  const id = Number(user && user.id) || 0;
  return 'JPN-BSS-' + String(id).padStart(6, '0');
}

function positionLabel(user) {
  if (user && Number(user.is_coordinator) === 1) return 'KOORDINATOR';
  return user && Number(user.is_head) === 1 ? 'HEAD MARKETING' : 'MARKETING';
}

module.exports = { memberId, positionLabel };
