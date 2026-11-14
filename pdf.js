/* יצירת PDF של הרשימה – עובד גם בלי אינטרנט (הכל נבנה בטלפון, בלי ספריות חיצוניות).
   כל עמוד מצויר על canvas (שמטפל בעברית ובכיוון RTL כמו הדפדפן), ונארז כקובץ PDF. */
(() => {
'use strict';
const W = 1240, H = 1754, M = 80;            // A4 בקירוב 150dpi
const GREEN = '#1f6b47', SOFT = '#e3f1e8', INK = '#1d2a22', MUTED = '#6b776f', LINE = '#d9d4c7';
const FONT = 'Rubik, "Segoe UI", Arial, sans-serif';

function newPage() {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  x.direction = 'rtl'; x.textBaseline = 'middle';
  return { c, x };
}
function text(x, s, px, py, { size = 32, weight = 400, color = INK, align = 'right' } = {}) {
  x.font = `${weight} ${size}px ${FONT}`; x.fillStyle = color; x.textAlign = align;
  x.fillText(s, px, py);
}
function fit(x, s, maxW) {
  if (x.measureText(s).width <= maxW) return s;
  while (s.length > 1 && x.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

function drawPages({ groups, title, subtitle }) {
  const pages = []; let p, y;
  const start = first => {
    p = newPage(); pages.push(p); y = M;
    if (first) {
      text(p.x, title, W - M, y + 30, { size: 54, weight: 800, color: GREEN });
      text(p.x, subtitle, W - M, y + 92, { size: 28, color: MUTED });
      y += 140;
      p.x.fillStyle = GREEN; p.x.fillRect(M, y, W - 2 * M, 4); y += 30;
    }
  };
  const ensure = need => { if (y + need > H - M - 40) start(false); };
  start(true);
  for (const g of groups) {
    ensure(60 + 66);                       // כותרת מחלקה + לפחות שורה אחת
    p.x.fillStyle = SOFT; p.x.fillRect(M, y, W - 2 * M, 56);
    text(p.x, `${g.icon}  ${g.name}  (${g.items.length})`, W - M - 18, y + 29, { size: 30, weight: 700, color: GREEN });
    y += 66;
    for (const it of g.items) {
      ensure(66);
      const box = 36, bx = W - M - 10 - box;
      p.x.strokeStyle = '#7d8a82'; p.x.lineWidth = 3; p.x.strokeRect(bx, y + 14, box, box);
      p.x.font = `500 34px ${FONT}`;
      const maxW = W - 2 * M - box - 140;
      text(p.x, fit(p.x, it.n, maxW), bx - 22, y + 33, { size: 34, weight: 500 });
      if (it.q > 1) { p.x.direction = 'ltr'; text(p.x, `×${it.q}`, M + 10, y + 33, { size: 34, weight: 800, color: GREEN, align: 'left' }); p.x.direction = 'rtl'; }
      p.x.strokeStyle = LINE; p.x.lineWidth = 2; p.x.setLineDash([6, 8]);
      p.x.beginPath(); p.x.moveTo(M, y + 64); p.x.lineTo(W - M, y + 64); p.x.stroke(); p.x.setLineDash([]);
      y += 66;
    }
    y += 22;
  }
  pages.forEach((pg, i) => text(pg.x, `עמוד ${i + 1} מתוך ${pages.length}`, W / 2, H - M / 2, { size: 24, color: MUTED, align: 'center' }));
  return pages.map(pg => pg.c);
}

// בניית קובץ PDF מינימלי: עמוד אחד לכל תמונת JPEG
function buildPdf(jpegs) {
  const enc = new TextEncoder(); const parts = []; let len = 0; const offs = [];
  const put = d => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); len += b.length; };
  const obj = (n, ...body) => { offs[n] = len; put(`${n} 0 obj\n`); body.forEach(put); put('\nendobj\n'); };
  put(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4
  const PW = 595.28, PH = 841.89, n = jpegs.length;
  const kids = jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  jpegs.forEach((j, i) => {
    const pg = 3 + i * 3, ct = pg + 1, im = pg + 2;
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`);
    const cs = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
    obj(ct, `<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`);
    obj(im, `<< /Type /XObject /Subtype /Image /Width ${j.w} /Height ${j.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.bytes.length} >>\nstream\n`, j.bytes, '\nendstream');
  });
  const total = 3 + n * 3, xref = len;
  put(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) put(`${String(offs[i]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

async function makeListPdf(data) {
  try { await document.fonts.ready; } catch {}
  const canvases = drawPages(data);
  const jpegs = canvases.map(c => {
    const b64 = c.toDataURL('image/jpeg', 0.9).split(',')[1];
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, w: c.width, h: c.height };
  });
  return buildPdf(jpegs);
}

window.ListPdf = { makeListPdf };
})();
