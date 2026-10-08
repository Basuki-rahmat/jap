const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
const BLANK = '....................';

// Konversi cm ke pt (1 cm = 28.3465 pt)
const cmToPt = (cm) => cm * 28.3465;

function fmtDateLong(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Menulis paragraf dengan segmen teks bold/italic (rich text)
function richPara(doc, segs, opts) {
  const o = Object.assign({ align: 'justify' }, opts || {});
  segs.forEach((s, i) => {
    doc.font(s.b ? 'Times-Bold' : s.i ? 'Times-Italic' : 'Times-Roman')
       .fontSize(11)
       .text(s.t, Object.assign({}, o, { continued: i < segs.length - 1 }));
  });
  doc.moveDown(0.35);
}

const CLAUSE_INDENT = 26;

// Klausa bernomor dengan hanging indent
function clause(doc, num, segs) {
  const x0 = doc.page.margins.left;
  const y0 = doc.y;
  doc.font('Times-Roman').fontSize(11).text(`${num}.`, x0, y0, { width: CLAUSE_INDENT });
  doc.x = x0;
  doc.y = y0;
  richPara(doc, segs, { indent: CLAUSE_INDENT, indentAllLines: true });
}

/**
 * Baris identitas dengan koordinat absolut agar titik dua (:) sejajar vertikal.
 * Opsi stacked: true → nilai ditulis di baris baru di bawah label.
 */
function identityRow(doc, label, value, opts) {
  const o = Object.assign({
    labelX: doc.page.margins.left,
    colonX: doc.page.margins.left + 195,
    valueX: doc.page.margins.left + 205,
    stacked: false,
  }, opts || {});

  const contentWidth = doc.page.width - doc.page.margins.right - o.valueX;
  const y = doc.y;

  doc.font('Times-Roman').fontSize(11);
  doc.text(label, o.labelX, y, { width: o.colonX - o.labelX - 4, align: 'left' });
  doc.text(':', o.colonX, y);
  if (o.stacked) {
    doc.moveDown(0.9);
    doc.text(value || BLANK, o.labelX, doc.y, { width: doc.page.width - doc.page.margins.right - o.labelX, align: 'left' });
  } else {
    doc.text(value || BLANK, o.valueX, y, { width: contentWidth, align: 'left' });
  }

  doc.moveDown(0.2);
}

/**
 * Membuat PDF SPPL sesuai format dokumen asli.
 * company: profil perusahaan dari Pengaturan (nama, alamat, kota, penandatangan).
 */
function generateSpplPdf(land, marketingName, approvalDate, company) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const fname = `sppl-${land ? land.id : 'doc'}-${Date.now()}.pdf`;
      const abs = path.join(uploadDir, fname);

      // Margin A4: Top 4cm, Right 3cm, Bottom 3cm, Left 3cm
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: cmToPt(4),
          right: cmToPt(3),
          bottom: cmToPt(3),
          left: cmToPt(3),
        },
      });

      const stream = fs.createWriteStream(abs);
      doc.pipe(stream);

      const L = land || {};
      const C = company || {};
      const kada = approvalDate ? new Date(approvalDate) : new Date();
      const year = isNaN(kada.getFullYear()) ? new Date().getFullYear() : kada.getFullYear();
      const noSurat = `${L.id || '...'}/SPPL/BSS/${year}`;

      // Format Jenis Hak & Nomor Sertipikat sejajar (pakai data surat bila ada)
      const docTypeUpper = (L.legal_doc_type || '').toUpperCase();
      const suratTxt = (L.surat || '').trim();
      const legalLabel = docTypeUpper
        ? (suratTxt ? `${docTypeUpper}, ${suratTxt}` : `${docTypeUpper}, No. ${BLANK}`)
        : BLANK;
      const hm = marketingName || BLANK;

      // Profil perusahaan untuk blok penyewa & tempat tanggal
      const compName = (C.company_name || '').trim() || BLANK;
      const compAddr = [C.company_address1, C.company_address2, C.company_city].filter((x) => x && String(x).trim()).join(', ') || BLANK;
      const compCity = (C.company_city || '').trim();
      const signerName = (C.signer_name || '').trim();
      const signerTitle = (C.signer_title || '').trim() || 'Direktur Utama';

      // Format Titik Tanggal (kota terisi bila ada di Pengaturan)
      const formattedDate = fmtDateLong(approvalDate);
      const textTgl = formattedDate
        ? (compCity ? `${compCity}, ${formattedDate}` : `................, ${formattedDate}`)
        : (compCity ? `${compCity}, .... ................ ${year}` : `................, .... ................ ${year}`);

      const pageLeft = doc.page.margins.left;
      const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // ================= HALAMAN 1: PERSETUJUAN =================
      doc.font('Times-Bold').fontSize(14).text('SURAT PERSETUJUAN PEMILIK LAHAN', { align: 'center' });
      doc.moveDown(0.2);
      doc.font('Times-Bold').fontSize(11).text(`No. : ${noSurat}`, { align: 'center' });
      doc.moveDown(0.8);

      richPara(doc, [
        { t: 'Yang bertanda tangan di bawah ini (selanjutnya disebut sebagai "Pemilik Lahan"),', b: true },
      ]);
      doc.font('Times-Roman').fontSize(11).text('menerangkan sebagai berikut:');
      doc.moveDown(0.5);

      identityRow(doc, 'Nama', L.owner_name);
      identityRow(doc, 'Tempat, Tanggal Lahir', L.ttl || BLANK);
      identityRow(doc, 'Alamat', L.address);
      identityRow(doc, 'Nomor Induk Kependudukan (NIK)', L.nik || BLANK);
      // Legalitas: sebaris seperti baris lain bila muat, stacked bila terlalu panjang
      doc.font('Times-Roman').fontSize(11);
      identityRow(doc, 'Jenis Hak & Nomor Sertipikat', legalLabel, {
        stacked: doc.widthOfString(legalLabel) > (doc.page.width - doc.page.margins.right - (doc.page.margins.left + 205)),
      });
      identityRow(doc, 'NIB & Nomor Surat Ukur', BLANK);
      identityRow(doc, 'Luas Bidang', `${L.area_size || BLANK} m²`);
      identityRow(doc, 'Atas Nama Sertipikat', L.owner_name);
      identityRow(doc, 'Alamat Lokasi Tanah', L.location_address || L.address);
      doc.moveDown(0.6);

      clause(doc, '1', [{ t: 'Pemilik Lahan adalah pemilik sah atas bidang tanah sebagaimana data pada tabel di atas.' }]);
      clause(doc, '2', [{ t: 'Pemilik Lahan dengan ini memberikan izin dan persetujuan kepada:' }]);

      const indentLabelX = pageLeft + 20;
      identityRow(doc, 'Nama Perusahaan', compName, { labelX: indentLabelX });
      identityRow(doc, 'Alamat', compAddr, { labelX: indentLabelX });
      identityRow(doc, 'NIB', BLANK, { labelX: indentLabelX });

      richPara(doc, [
        { t: '(selanjutnya disebut sebagai ' },
        { t: '"Penyewa"', b: true },
        { t: ').' },
      ], { indent: CLAUSE_INDENT, indentAllLines: true });
      
      clause(doc, '3', [
        { t: 'Pemilik Lahan memberikan izin kepada Penyewa untuk menyewakan kembali (sublease) sebagian atau ukuran ' },
        { t: '1 meter x 1,5 meter untuk BSS dan 3 meter x 6 meter untuk EVCS', b: true },
        { t: ' milik Pemilik Lahan tersebut kepada ' },
        { t: 'PT Vgreen Global Charging Station Investment Indonesia ("VGreen")', b: true },
        { t: ', untuk digunakan sebagai lokasi Stasiun Pengisian Kendaraan Listrik (SPKL) beserta fasilitas penunjangnya.' },
      ]);
      clause(doc, '4', [{ t: 'Pemilik Lahan mengetahui dan menyetujui bahwa perjanjian sewa menyewa akan dilaksanakan antara Penyewa dan VGreen.' }]);
      clause(doc, '5', [{ t: 'Pemilik Lahan tidak akan mengajukan keberatan, tuntutan, atau klaim dalam bentuk apa pun terhadap pelaksanaan perjanjian tersebut sepanjang dilaksanakan sesuai dengan peraturan perundang-undangan yang berlaku di Republik Indonesia.' }]);
      clause(doc, '6', [{ t: 'Surat Persetujuan ini dibuat dan ditandatangani secara sadar, tanpa paksaan dari pihak mana pun, untuk digunakan sebagaimana mestinya.' }]);

      doc.moveDown(0.3);
      doc.font('Times-Roman').fontSize(11).text(textTgl, { align: 'right' });
      doc.moveDown(0.5);

      {
        const y = doc.y;
        const colWidth = contentWidth / 2;
        doc.font('Times-Bold').fontSize(11).text('PEMILIK LAHAN', pageLeft, y, { width: colWidth, align: 'center' });
        doc.font('Times-Bold').fontSize(11).text('PENYEWA', pageLeft + colWidth, y, { width: colWidth, align: 'center' });
        doc.moveDown(3.2);
        const ySign = doc.y;
        doc.font('Times-Roman').fontSize(11).text('...........................', pageLeft, ySign, { width: colWidth, align: 'center' });
        doc.font('Times-Bold').fontSize(11).text(signerName || '...........................', pageLeft + colWidth, ySign, { width: colWidth, align: 'center' });
        doc.font('Times-Italic').fontSize(11).text(signerTitle, pageLeft + colWidth, doc.y, { width: colWidth, align: 'center' });
        doc.moveDown(0.5);
      }

      // ================= HALAMAN 2: PERNYATAAN =================
      doc.addPage();
      doc.font('Times-Bold').fontSize(14).text('SURAT PERNYATAAN PEMILIK LAHAN', { align: 'center' });
      doc.moveDown(0.8);
      doc.font('Times-Roman').fontSize(11).text('Yang bertanda tangan di bawah ini:');
      doc.moveDown(0.5);

      identityRow(doc, 'Nama', L.owner_name);
      identityRow(doc, 'Alamat', L.address);
      identityRow(doc, 'No. KTP', L.nik || BLANK);
      doc.moveDown(0.2);
      identityRow(doc, 'Lokasi Lahan', L.location_address || L.address);
      doc.moveDown(0.5);

      doc.font('Times-Roman').fontSize(11).text('Dengan ini menyatakan bahwa:');
      doc.moveDown(0.4);

      clause(doc, '1', [
        { t: 'Saya selaku pemilik lahan memberikan izin penuh untuk melakukan proses pengajuan sewa ' },
        { t: 'lahan', b: true },
        { t: ' guna pembangunan infrastruktur ' },
        { t: 'Stasiun Pengisian Kendaraan Listrik (EVCS)', b: true },
        { t: ' dan ' },
        { t: 'Stasiun Penukaran Baterai (BSS)', b: true },
        { t: ' pada lokasi lahan tersebut.' },
      ]);
      clause(doc, '2', [
        { t: 'Saya memahami bahwa proses administrasi dan survei untuk pengajuan tersebut membutuhkan waktu yang signifikan, yaitu ' },
        { t: 'di atas 3 (tiga) bulan.', b: true },
      ]);
      clause(doc, '3', [
        { t: 'Selama proses pengajuan tersebut berlangsung, saya berkomitmen untuk ' },
        { t: 'tidak membatalkan kesepakatan atau mengalihkan/menyewakan lahan tersebut kepada pihak lain.', b: true },
      ]);
      clause(doc, '4', [
        { t: 'Apabila di kemudian hari, setelah data lahan dinyatakan ' },
        { t: '"Approved"', b: true },
        { t: ' (disetujui), saya selaku pemilik lahan melakukan pembatalan secara sepihak, maka saya bersedia menerima sanksi berupa ' },
        { t: 'denda pembatalan sebesar Rp500.000,00', b: true },
        { t: ' (lima ratus ribu rupiah).' },
      ]);
      clause(doc, '5', [
        { t: 'Denda tersebut merupakan bentuk penggantian biaya operasional yang telah dikeluarkan oleh pihak ' },
        { t: 'Head Marketing (HM)', b: true },
        { t: ` atas nama [ ${hm} ] dalam proses survei, pengumpulan data, dan pengurusan administrasi lahan saya.` },
      ]);

      richPara(doc, [{ t: 'Demikian surat pernyataan ini saya buat dengan sadar, tanpa paksaan dari pihak manapun, dan untuk dapat dipergunakan sebagaimana mestinya.' }]);

      doc.moveDown(0.5);

      {
        const signColWidth = 200;
        const signX = pageLeft + contentWidth - signColWidth;
        doc.font('Times-Roman').fontSize(11).text(textTgl, signX, doc.y, { width: signColWidth, align: 'right' });
        doc.moveDown(0.3);
        doc.font('Times-Roman').fontSize(11).text('Yang membuat pernyataan,', signX, doc.y, { width: signColWidth, align: 'center' });
        doc.moveDown(3);
        doc.font('Times-Bold').fontSize(11).text(`[ ${L.owner_name || '....................'} ]`, signX, doc.y, { width: signColWidth, align: 'center' });
      }

      doc.end();
      stream.on('finish', () => resolve('/uploads/' + fname));
      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateSpplPdf, fmtDateLong };