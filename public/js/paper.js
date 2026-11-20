// Paper model + rendering of typed sheets with per-strike ink variation.
import { glyphStyle } from './ink.js';

export const CW = 12; // px per character cell (pica: 10 chars / inch, scaled)
export const LH = 20; // px per line (6 lines / inch at the same scale)
export const MARGIN_COLS = 10; // left & right paper margin, in cells
export const MARGIN_ROWS = 6; // top & bottom paper margin, in lines
export const GAP = 40; // vertical gap between sheets

export const DEFAULTS = {
  cols: 65,
  linesPerPage: 54,
  spacing: 1,
  paper: 'ivory',
  face: 'elite',
  ink: 0,
  sound: true,
  volume: 0.6,
  corrections: 'none',
  margin: 'lock',
  lamp: '#7d9bff',
};

export function withDefaults(s) {
  return { ...DEFAULTS, ...(s || {}) };
}

export { glyphStyle };

/* ---------- text helpers ---------- */
export function linesToText(lines) {
  return lines
    .map((line) => (line || []).map((c) => (c && c.length ? c[c.length - 1][0] : ' ')).join('').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\s+$/, '');
}

/**
 * Word-wrap plain text to a line width, like a typist would: break at the last
 * space, hard-break words longer than a line, expand tabs to 5-column stops.
 * `startCol` is where the carriage already sits on the first line.
 */
export function wrapText(text, cols, startCol = 0) {
  const out = [];
  String(text).replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
    let line = '';
    for (const ch of raw) {
      if (ch === '\t') line += ' '.repeat(5 - (line.length % 5));
      else line += ch;
    }
    line = line.replace(/\s+$/, '');
    let width = idx === 0 ? Math.max(1, cols - startCol) : cols;
    if (!line) { out.push(''); return; }
    while (Array.from(line).length > width) {
      const chars = Array.from(line);
      let cut = chars.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      out.push(chars.slice(0, cut).join('').replace(/\s+$/, ''));
      line = chars.slice(cut).join('').replace(/^ +/, '');
      width = cols;
    }
    out.push(line);
  });
  return out;
}

/**
 * Lay PDF pages onto typewriter sheets: each source page starts on a fresh
 * sheet when it fits; longer pages simply run on.
 */
export function pagesToLines(pages, cols, lpp, maxRows = 4999) {
  const lines = [];
  let truncated = false;
  pages.forEach((pageText, pi) => {
    const wrapped = wrapText(pageText.replace(/\n{3,}/g, '\n\n').trim(), cols);
    if (pi > 0 && lines.length % lpp !== 0) {
      while (lines.length % lpp !== 0) lines.push([]);
    }
    for (const l of wrapped) {
      if (lines.length >= maxRows) { truncated = true; return; }
      lines.push(Array.from(l).map((ch) => (ch === ' ' ? null : [[ch, 0]])));
    }
  });
  while (lines.length && !lines[lines.length - 1].length) lines.pop();
  return { lines: lines.length ? lines : [[]], truncated };
}

export function countWords(lines) {
  return linesToText(lines).split(/\s+/).filter(Boolean).length;
}

/* ---------- renderer ---------- */
export class Paper {
  constructor(container, settings) {
    this.el = container;
    this.el.classList.add('sheets');
    this.settings = withDefaults(settings);
    this.sheets = [];
    this.lineEls = new Map();
    this.layout();
  }

  get lpp() { return this.settings.linesPerPage; }
  get sheetW() { return (this.settings.cols + MARGIN_COLS * 2) * CW; }
  get sheetH() { return (this.lpp + MARGIN_ROWS * 2) * LH; }

  setSettings(s) {
    const prev = this.settings;
    this.settings = withDefaults({ ...prev, ...s });
    this.layout();
  }

  layout() {
    const s = this.settings;
    this.el.dataset.paper = s.paper;
    this.el.dataset.face = s.face;
    this.el.style.setProperty('--sheet-w', `${this.sheetW}px`);
    this.el.style.setProperty('--sheet-h', `${this.sheetH}px`);
    this.el.style.setProperty('--cw', `${CW}px`);
    this.el.style.setProperty('--lh', `${LH}px`);
    this.sheets.forEach((sh, p) => this.positionSheet(sh, p));
    this.el.style.height = `${this.totalHeight()}px`;
    this.el.style.width = `${this.sheetW}px`;
  }

  totalHeight() {
    const n = Math.max(1, this.sheets.length);
    return n * this.sheetH + (n - 1) * GAP;
  }

  pageTop(p) { return p * (this.sheetH + GAP); }

  /** Position (in sheets-container px) of the top-left of a cell. */
  cellPos(row, col) {
    const p = Math.floor(row / this.lpp);
    const rp = row % this.lpp;
    return {
      x: (MARGIN_COLS + col) * CW,
      y: this.pageTop(p) + (MARGIN_ROWS + rp) * LH,
      page: p,
    };
  }

  /** Inverse of cellPos, clamped to the typing area. */
  hit(x, y) {
    const p = Math.max(0, Math.floor(y / (this.sheetH + GAP)));
    const yIn = y - this.pageTop(p);
    const rp = Math.min(this.lpp - 1, Math.max(0, Math.floor(yIn / LH) - MARGIN_ROWS));
    const col = Math.min(this.settings.cols, Math.max(0, Math.floor(x / CW) - MARGIN_COLS));
    return { row: p * this.lpp + rp, col };
  }

  positionSheet(sh, p) {
    sh.style.top = `${this.pageTop(p)}px`;
    for (const [row, el] of this.lineEls) {
      if (Math.floor(row / this.lpp) === p) el.style.top = `${(MARGIN_ROWS + (row % this.lpp)) * LH}px`;
    }
  }

  ensurePages(n) {
    let added = false;
    while (this.sheets.length < n) {
      const p = this.sheets.length;
      const sh = document.createElement('div');
      sh.className = 'sheet';
      sh.innerHTML = `<div class="sheet-num">${p + 1}</div>`;
      this.el.appendChild(sh);
      this.sheets.push(sh);
      this.positionSheet(sh, p);
      added = true;
    }
    while (this.sheets.length > n) {
      const sh = this.sheets.pop();
      sh.remove();
      added = true;
    }
    if (added) this.el.style.height = `${this.totalHeight()}px`;
  }

  renderLine(row, cells) {
    const p = Math.floor(row / this.lpp);
    this.ensurePages(Math.max(this.sheets.length, p + 1));
    let el = this.lineEls.get(row);
    const empty = !cells || !cells.some((c) => c && c.length);
    if (empty) {
      if (el) { el.remove(); this.lineEls.delete(row); }
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'tl';
      el.style.top = `${(MARGIN_ROWS + (row % this.lpp)) * LH}px`;
      this.sheets[p].appendChild(el);
      this.lineEls.set(row, el);
    }
    let html = '';
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col];
      if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        const [ch, ink] = cell[i];
        if (ch === ' ') continue;
        const g = glyphStyle(row, col, i, ch);
        const esc = ch === '<' ? '&lt;' : ch === '&' ? '&amp;' : ch === '>' ? '&gt;' : ch;
        const m = g.mask ? `-webkit-mask-image:${g.mask};mask-image:${g.mask};` : '';
        html += `<span class="g${ink ? ' red' : ''}" style="left:${col * CW}px;transform:translate(${g.dx.toFixed(2)}px,${g.dy.toFixed(2)}px) rotate(${g.rot.toFixed(2)}deg);opacity:${g.op.toFixed(2)};${m}">${esc}</span>`;
      }
    }
    el.innerHTML = html;
  }

  renderAll(lines, minRows = 1) {
    for (const el of this.lineEls.values()) el.remove();
    this.lineEls.clear();
    const rows = Math.max(lines.length, minRows);
    this.ensurePages(Math.max(1, Math.ceil(rows / this.lpp)));
    lines.forEach((cells, r) => this.renderLine(r, cells));
  }
}
