// Paper model + rendering of typed sheets with per-strike ink variation.

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

/* ---------- deterministic randomness so ink looks the same every render ---------- */
function mix(...nums) {
  let h = 2166136261;
  for (const n of nums) {
    h ^= n;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}
function rng(seed) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const slugCache = new Map();
/** Each letter's typebar is slightly misaligned — consistently, like a real machine. */
function slug(ch) {
  let s = slugCache.get(ch);
  if (!s) {
    const r = rng(mix(ch.codePointAt(0), 7919));
    s = { dx: (r() - 0.5) * 0.9, dy: (r() - 0.5) * 1.8, rot: (r() - 0.5) * 1.6, weight: 0.88 + r() * 0.14 };
    slugCache.set(ch, s);
  }
  return s;
}

export function glyphStyle(row, col, i, ch) {
  const r = rng(mix(row, col, i, ch.codePointAt(0)));
  const s = slug(ch);
  const dx = s.dx + (r() - 0.5) * 0.7;
  const dy = s.dy + (r() - 0.5) * 0.7;
  const rot = s.rot + (r() - 0.5) * 1.2;
  let op = s.weight * (0.8 + r() * 0.2);
  if (r() < 0.04) op *= 0.62; // a light strike
  let mask = '';
  if (r() < 0.3) {
    // uneven pressure: one side of the letter inks lighter
    const ang = Math.floor(r() * 360);
    const lo = (0.35 + r() * 0.35).toFixed(2);
    mask = `linear-gradient(${ang}deg, #000 ${30 + Math.floor(r() * 30)}%, rgba(0,0,0,${lo}))`;
  }
  return { dx, dy, rot, op, mask };
}

/* ---------- text helpers ---------- */
export function linesToText(lines) {
  return lines
    .map((line) => (line || []).map((c) => (c && c.length ? c[c.length - 1][0] : ' ')).join('').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\s+$/, '');
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
