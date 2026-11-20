'use strict';
/**
 * PDF export and import.
 *  - renderPdf: lays typed sheets onto US Letter pages with the same
 *    per-strike ink jitter as the browser (shared via public/js/ink.js).
 *  - extractPdfText: pulls selectable text out of an uploaded PDF.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const PDFDocument = require('pdfkit');
const fontkit = require('fontkit');

const CW = 12; // must match public/js/paper.js
const LH = 20;
const MARGIN_COLS = 10;
const MARGIN_ROWS = 6;
const FONT_PX = 19;
const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const INK = ['#1f1c1a', '#ad2a1c'];

const font = (pkg, file) => path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), 'files', file);
const FACES = {
  elite: [
    font('special-elite', 'special-elite-latin-400-normal.woff'),
    font('special-elite', 'special-elite-latin-ext-400-normal.woff'),
  ],
  prime: [
    font('courier-prime', 'courier-prime-latin-400-normal.woff'),
    font('courier-prime', 'courier-prime-latin-ext-400-normal.woff'),
  ],
};

// fontkit fonts for drawing glyph outlines (cached per file)
const fkCache = new Map();
const fk = (file) => {
  if (!fkCache.has(file)) fkCache.set(file, fontkit.openSync(file));
  return fkCache.get(file);
};
const TEXT_LAYER_FONTS = [
  font('courier-prime', 'courier-prime-latin-400-normal.woff'),
  font('courier-prime', 'courier-prime-latin-ext-400-normal.woff'),
];

let inkModule = null;
const loadInk = () =>
  (inkModule ||= import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'ink.js')).href));

/** Render a document to a PDF, piping into `out` (e.g. an HTTP response). */
async function renderPdf(out, { title, author, content, settings }) {
  const { glyphStyle } = await loadInk();
  const s = settings || {};
  const cols = Number.isInteger(s.cols) ? s.cols : 65;
  const lpp = Number.isInteger(s.linesPerPage) ? s.linesPerPage : 54;
  const face = s.face === 'prime' ? 'prime' : 'elite';
  const lines = (content && content.lines) || [];

  const sheetW = (cols + MARGIN_COLS * 2) * CW;
  const sheetH = (lpp + MARGIN_ROWS * 2) * LH;
  const k = Math.min(PAGE_W / sheetW, PAGE_H / sheetH);
  const offX = (PAGE_W - sheetW * k) / 2;
  const offY = (PAGE_H - sheetH * k) / 2;
  const size = FONT_PX * k;
  const baseline = LH * 0.74 * k;

  let lastRow = lines.length - 1;
  while (lastRow >= 0 && !(lines[lastRow] || []).some((c) => c && c.length)) lastRow--;
  const pages = Math.max(1, Math.ceil((lastRow + 1) / lpp));

  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 0,
    autoFirstPage: false,
    info: { Title: title || 'Untitled', Author: author || '', Creator: 'Naoko', Producer: 'Naoko' },
  });
  doc.pipe(out);
  TEXT_LAYER_FONTS.forEach((f, i) => doc.registerFont(`layer-${i}`, f));
  const layerFks = TEXT_LAYER_FONTS.map(fk);
  const layerAdvance = layerFks[0].layout('M').glyphs[0].advanceWidth / layerFks[0].unitsPerEm; // em per char
  const layerSize = (CW * k) / layerAdvance;
  const layerFor = (ch) => layerFks.findIndex((f) => f.hasGlyphForCodePoint(ch.codePointAt(0)));

  // Visible letters are drawn as outlines (so the ink jitter is exact and
  // they don't fragment the text layer). Find a face that has the glyph.
  const faces = FACES[face].map(fk);
  const glyphCache = new Map();
  const glyphFor = (ch) => {
    if (glyphCache.has(ch)) return glyphCache.get(ch);
    const cp = ch.codePointAt(0);
    let hit = null;
    for (const f of faces) {
      if (f.hasGlyphForCodePoint(cp)) {
        const g = f.layout(ch).glyphs[0];
        hit = { svg: g.path.toSVG(), adv: g.advanceWidth, upm: f.unitsPerEm };
        break;
      }
    }
    glyphCache.set(ch, hit);
    return hit;
  };

  for (let p = 0; p < pages; p++) {
    doc.addPage({ size: 'LETTER', margin: 0 });
    for (let rp = 0; rp < lpp; rp++) {
      const row = p * lpp + rp;
      const cells = lines[row];
      if (!cells || !cells.length) continue;
      const top = offY + (MARGIN_ROWS + rp) * LH * k;
      const left = offX + MARGIN_COLS * CW * k;

      // 1. Invisible, evenly spaced text layer for search / copy / screen readers.
      const text = cells.map((c) => (c && c.length ? c[c.length - 1][0] : ' ')).join('').replace(/\s+$/, '');
      if (text) {
        // split into runs by which font subset covers each character
        const chars = Array.from(text);
        const runs = [];
        chars.forEach((ch, c) => {
          const f = ch === ' ' ? -2 : layerFor(ch);
          const last = runs[runs.length - 1];
          if (f === -2 && last) { last.s += ch; return; } // spaces join the current run
          if (last && last.f === f) last.s += ch;
          else runs.push({ f, col: c, s: ch });
        });
        doc.save();
        doc.addContent('3 Tr'); // text render mode: invisible
        for (const r of runs) {
          if (r.f < 0) continue; // no font can encode it: leave it out of the text layer
          doc.font(`layer-${r.f}`).fontSize(layerSize);
          doc.text(r.s, left + r.col * CW * k, top + baseline, { lineBreak: false, baseline: 'alphabetic' });
        }
        doc.restore();
      }

      // 2. The inked letters, every strike of every cell.
      for (let col = 0; col < cells.length; col++) {
        const cell = cells[col];
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const [ch, inkColor] = cell[i];
          if (!ch || ch === ' ') continue;
          const g = glyphStyle(row, col, i, ch);
          const cx = left + col * CW * k + (CW * k) / 2;
          const color = INK[inkColor === 1 ? 1 : 0];
          const opacity = Math.min(1, g.op + 0.05);
          const glyph = glyphFor(ch);
          doc.save();
          doc.translate(cx + g.dx * k, top + baseline + g.dy * k);
          doc.rotate(g.rot);
          if (glyph) {
            const sc = size / glyph.upm;
            doc.scale(sc, -sc);
            doc.translate(-glyph.adv / 2, 0);
            doc.path(glyph.svg).fillColor(color, opacity).fill();
          } else {
            // character outside the typewriter fonts: mark the cell with a small struck box
            const bw = CW * k * 0.55;
            const bh = size * 0.62;
            doc.rect(-bw / 2, -bh, bw, bh).lineWidth(0.6).strokeColor(color, opacity).stroke();
          }
          doc.restore();
        }
      }
    }
  }
  doc.end();
}

/* ------------------------------------------------------------------ */
let unpdf = null;
const loadUnpdf = () => (unpdf ||= import('unpdf'));

/**
 * Extract text per page from a PDF buffer.
 * @returns {{ title: string|null, pages: string[] }}
 */
async function extractPdfText(buffer) {
  const { getDocumentProxy, extractText, getMeta } = await loadUnpdf();
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch (e) {
    const err = new Error(/password/i.test(e && e.message) ? 'This PDF is password-protected.' : 'That file could not be read as a PDF.');
    err.status = 422;
    throw err;
  }
  let title = null;
  try {
    const meta = await getMeta(pdf);
    title = (meta && meta.info && typeof meta.info.Title === 'string' && meta.info.Title.trim()) || null;
  } catch { /* metadata is optional */ }
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((t) =>
    String(t || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/[  ]+\n/g, '\n')
  );
  const total = pages.reduce((n, t) => n + t.trim().length, 0);
  if (!total) {
    const err = new Error('No selectable text found in this PDF (it may be a scan).');
    err.status = 422;
    throw err;
  }
  return { title, pages };
}

module.exports = { renderPdf, extractPdfText };
