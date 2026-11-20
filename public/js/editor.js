// The typewriter: a lamp-lit carriage on a dark desk, margin bell and ribbon.
import { api } from './api.js';
import { sound } from './sound.js';
import { icons } from './icons.js';
import { Paper, CW, LH, MARGIN_COLS, withDefaults, linesToText, countWords } from './paper.js';
import { toast, modal, escapeHtml, menu } from './ui.js';

const MAX_ROWS = 4999;
const TAB = 5;
const BELL_BEFORE = 7;
const PAGE_TOP = 72; // clear the floating toolbar in page view
const SENTINEL = '​​';

export const LAMP_PRESETS = [
  ['#7d9bff', 'Moonlight'],
  ['#ffb766', 'Tungsten'],
  ['#ff8a3d', 'Candle'],
  ['#ff4b3e', 'Darkroom'],
  ['#ff7eb6', 'Neon rose'],
  ['#b48cff', 'Violet'],
  ['#8fe9ff', 'Ice'],
  ['#6dff9b', 'Phosphor'],
  ['#f4f1e8', 'Daylight'],
];
const HEX_RE = /^#[0-9a-f]{6}$/i;

const EASE = {
  step: 'transform 55ms cubic-bezier(.2,.8,.3,1)',
  ret: 'transform 420ms cubic-bezier(.35,.0,.15,1)',
  roll: 'transform 140ms cubic-bezier(.2,.8,.3,1)',
  jump: 'transform 260ms cubic-bezier(.2,.8,.3,1)',
  none: 'none',
};

export function mountEditor(root, { doc, navigate }) {
  let settings = withDefaults(doc.settings);
  const lines = (doc.content && doc.content.lines ? doc.content.lines : [[]]).map((l) => (Array.isArray(l) ? l : []));
  let row = settings.cursor ? Math.min(settings.cursor.row, MAX_ROWS) : 0;
  let col = settings.cursor ? Math.min(settings.cursor.col, settings.cols) : 0;
  let view = localStorage.getItem('naoko:view') === 'page' ? 'page' : 'carriage';
  let scrollY = 0;
  let title = doc.title;
  let dirty = false;
  let saving = false;
  let saveTimer = null;
  let statsTimer = null;
  let queue = [];
  let queueTimer = null;
  let warnedMargin = false;
  let destroyed = false;

  sound.configure({ enabled: settings.sound, volume: settings.volume });

  root.innerHTML = `
  <div class="editor">
    <header class="ed-bar">
      <button class="icon-btn" data-act="home" title="All documents" aria-label="All documents">${icons.back}</button>
      <a class="brand-sm" href="#/docs" aria-label="Naoko home">naoko</a>
      <input class="ed-title" maxlength="120" spellcheck="false" aria-label="Document title" value="${escapeHtml(title)}" />
      <span class="save-state" data-state="saved">Saved</span>
      <div class="spacer"></div>
      <div class="seg" role="tablist" aria-label="View">
        <button data-view="carriage" role="tab">Carriage</button>
        <button data-view="page" role="tab">Pages</button>
      </div>
      <button class="icon-btn ribbon-btn" data-act="ink" title="Switch ribbon colour" aria-label="Switch ribbon colour">
        <span class="ribbon"><i></i><i></i></span>
      </button>
      <button class="icon-btn lamp-btn" data-act="lamp" title="Lamp colour" aria-label="Lamp colour" aria-haspopup="dialog"><span class="lamp-swatch"></span></button>
      <button class="icon-btn" data-act="sound" title="Sound" aria-label="Toggle sound"></button>
      <button class="icon-btn" data-act="settings" title="Typewriter settings" aria-label="Typewriter settings">${icons.settings}</button>
      <button class="icon-btn" data-act="export" title="Export" aria-label="Export">${icons.download}</button>
      <button class="btn btn-primary btn-sm" data-act="share">${icons.share}<span>Share</span></button>
    </header>
    <main class="desk" data-view="carriage" tabindex="-1">
      <div class="stage">
        <div class="carriage">
          <div class="roll"><div class="sheets"></div><div class="caret"></div></div>
          <div class="scale"></div>
        </div>
        <div class="rail"></div>
        <div class="lamp" aria-hidden="true">
          <div class="lamp-falloff"></div>
          <div class="lamp-cone"></div>
          <div class="lamp-tint"></div>
          <canvas class="lamp-motes" width="440" height="380"></canvas>
          <div class="lamp-spill"></div>
          <div class="lamp-bloom"></div>
          <div class="lamp-stem"></div>
          <div class="lamp-head"><i></i></div>
        </div>
      </div>
      <div class="vignette" aria-hidden="true"></div>
      <textarea class="keys" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Typewriter keyboard input"></textarea>
    </main>
    <footer class="ed-status">
      <span class="words" data-k="words"></span>
      <span class="aux" data-k="pos"></span>
      <span class="aux" data-k="mode"></span>
      <span class="spacer"></span>
      <span class="aux hint-k"><kbd>Return</kbd> new line · <kbd>↑</kbd><kbd>↓</kbd> roll · paste to auto-type</span>
    </footer>
  </div>`;

  const $ = (sel) => root.querySelector(sel);
  const desk = $('.desk');
  const stage = $('.stage');
  const carriage = $('.carriage');
  const roll = $('.roll');
  const caret = $('.caret');
  const editorEl = $('.editor');
  const scaleEl = $('.scale');
  const rail = $('.rail');
  const lamp = $('.lamp');
  const keys = $('.keys');
  const titleInput = $('.ed-title');
  const saveState = $('.save-state');
  const paper = new Paper($('.sheets'), settings);

  /* ---------------------------------------------------------------- */
  /* Dust drifting through the beam                                    */
  /* ---------------------------------------------------------------- */
  const motes = (() => {
    const canvas = $('.lamp-motes');
    const ctx = canvas.getContext('2d');
    const W = 440;
    const H = 380;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const SPREAD = Math.tan((26 * Math.PI) / 180); // beam half-angle
    let rgb = [125, 155, 255];
    let raf = 0;
    let last = 0;
    const spawn = (anywhere) => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.9,
      y: anywhere ? Math.random() * H : H + 4,
      r: 0.35 + Math.random() * Math.random() * 1.5,
      vx: (Math.random() - 0.5) * 4,
      vy: -(1.5 + Math.random() * 5),
      ph: Math.random() * Math.PI * 2,
      tw: 0.4 + Math.random() * 1.4,
    });
    const dust = Array.from({ length: 46 }, () => spawn(true));

    function frame(t) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      ctx.clearRect(0, 0, W, H);
      for (const m of dust) {
        // slow Brownian drift, warm air rising
        m.vx += (Math.random() - 0.5) * 6 * dt;
        m.vy += (Math.random() - 0.5) * 4 * dt;
        m.vx *= 0.995;
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        m.ph += m.tw * dt;
        if (m.y < -4 || m.x < -4 || m.x > W + 4) Object.assign(m, spawn(false));
        const dy = H - m.y; // distance from the bulb
        const half = 10 + dy * SPREAD;
        const edge = Math.max(0, 1 - Math.abs(m.x - W / 2) / half);
        if (!edge) continue;
        const fall = 1 / (1 + (dy / 150) ** 2);
        const a = edge * edge * (3 - 2 * edge) * fall * (0.55 + 0.45 * Math.sin(m.ph)) * 0.9;
        if (a < 0.02) continue;
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return {
      setColor(r, g, b) {
        // dust catches the light a little whiter than the beam itself
        rgb = [r, g, b].map((c) => Math.round(c + (255 - c) * 0.45));
      },
      start() {
        if (reduce || raf || document.hidden || view !== 'carriage') return;
        last = 0;
        raf = requestAnimationFrame(frame);
      },
      stop() {
        cancelAnimationFrame(raf);
        raf = 0;
      },
    };
  })();

  /* ---------------------------------------------------------------- */
  /* Rendering & geometry                                              */
  /* ---------------------------------------------------------------- */
  let geo = { s: 1, w: 0, h: 0, sx: 0, sy: 0 };

  function measure() {
    const r = desk.getBoundingClientRect();
    const sheetW = paper.sheetW;
    const s = view === 'page' ? Math.min(1, (r.width - 24) / sheetW) : Math.min(1, r.width / (CW * 48));
    stage.style.zoom = s;
    const w = r.width / s;
    const h = r.height / s;
    geo = { s, w, h, sx: Math.round(w / 2), sy: Math.round(h * 0.5) };
    stage.style.width = `${w}px`;
    stage.style.height = `${h}px`;
    paper.el.style.setProperty('--print-zoom', String(816 / sheetW));
    desk.style.setProperty('--strike-y', `${(geo.sy + 24) * s}px`);
    desk.style.setProperty('--rail-y', `${(geo.sy + 14) * s}px`);
    layoutFixtures();
  }

  function layoutFixtures() {
    const { sx, sy } = geo;
    rail.style.top = `${sy + 14}px`;
    scaleEl.style.top = `${sy + 10}px`;
    lamp.style.left = `${sx}px`;
    lamp.style.top = `${sy + 14}px`;
    buildScale();
  }

  function buildScale() {
    const cols = settings.cols;
    const left = MARGIN_COLS * CW;
    // faint ticks on the rail: left margin, margin bell, right margin
    scaleEl.style.left = `${left}px`;
    scaleEl.innerHTML =
      `<span class="stop" style="left:0" title="Left margin"></span>` +
      `<span class="bellmark" style="left:${(cols - BELL_BEFORE) * CW}px" title="Margin bell"></span>` +
      `<span class="stop" style="left:${cols * CW}px" title="Right margin"></span>`;
  }

  function maxScroll() {
    return Math.max(0, paper.totalHeight() - geo.h + PAGE_TOP + 60);
  }

  function place(kind = 'step') {
    const pos = paper.cellPos(row, col);
    let x;
    let y;
    if (view === 'carriage') {
      x = geo.sx - (pos.x + CW / 2);
      y = geo.sy - LH - pos.y;
    } else {
      x = Math.round((geo.w - paper.sheetW) / 2);
      y = PAGE_TOP - scrollY;
    }
    carriage.style.transition = EASE[kind] || EASE.step;
    roll.style.transition = view === 'carriage' ? EASE[kind === 'step' ? 'roll' : kind] || EASE.roll : EASE[kind === 'step' ? 'none' : kind];
    carriage.style.transform = `translate3d(${x}px,0,0)`;
    roll.style.transform = `translate3d(0,${y}px,0)`;
    caret.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    updateReadouts(pos.page);
  }

  /** In page view, keep the caret in sight. */
  function followCaret() {
    if (view !== 'page') return;
    const { y } = paper.cellPos(row, col);
    const top = y + PAGE_TOP - scrollY;
    if (top < 40) scrollY = Math.max(0, y - 80);
    else if (top > geo.h - 80) scrollY = Math.min(maxScroll(), y - geo.h + 140);
  }

  function updateReadouts(page) {
    const pages = Math.max(paper.sheets.length, page + 1);
    root.querySelector('[data-k="pos"]').textContent = `Ln ${(row % settings.linesPerPage) + 1}, Col ${col + 1} · Page ${page + 1} of ${pages}`;
  }

  function updateStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      const w = countWords(lines);
      root.querySelector('[data-k="words"]').textContent = `${w.toLocaleString()} word${w === 1 ? '' : 's'}`;
    }, 250);
  }

  function updateChrome() {
    desk.dataset.view = view;
    root.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
    root.querySelector('.ribbon-btn').dataset.ink = settings.ink ? 'red' : 'black';
    root.querySelector('[data-act="sound"]').innerHTML = settings.sound ? icons.soundOn : icons.soundOff;
    root.querySelector('[data-k="mode"]').textContent =
      (settings.corrections === 'tape' ? 'Correction tape' : 'Purist — no erasing') +
      (settings.margin === 'wrap' ? ' · Auto-return' : ' · Margin lock');
    caret.classList.toggle('red', !!settings.ink);
    applyLamp(settings.lamp);
  }

  /** Light colour of the carriage lamp: drives every glow via CSS variables. */
  function applyLamp(hex) {
    if (!HEX_RE.test(hex || '')) hex = '#7d9bff';
    const n = parseInt(hex.slice(1), 16);
    document.body.style.setProperty('--lamp', hex);
    document.body.style.setProperty('--lamp-rgb', `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`);
    motes.setColor((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }

  function lampSwatches(cur) {
    const presets = LAMP_PRESETS.map(
      ([hex, name]) =>
        `<button type="button" class="swatch" data-lamp="${hex}" title="${name}" aria-label="${name}" aria-pressed="${hex.toLowerCase() === String(cur).toLowerCase()}" style="--c:${hex}"></button>`
    ).join('');
    const custom = !LAMP_PRESETS.some(([h]) => h.toLowerCase() === String(cur).toLowerCase());
    return `<div class="swatches">${presets}
      <label class="swatch custom" title="Custom colour" aria-pressed="${custom}" style="--c:${cur}">
        <input type="color" value="${cur}" aria-label="Custom lamp colour" /><span>+</span>
      </label></div>`;
  }

  /** Wire a swatch block: live preview while dragging the custom picker, save on release. */
  function bindSwatches(scope, onPick) {
    scope.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lamp]');
      if (!b) return;
      e.preventDefault();
      setLamp(b.dataset.lamp, scope);
      onPick && onPick();
    });
    const input = scope.querySelector('input[type="color"]');
    input.addEventListener('input', () => applyLamp(input.value));
    input.addEventListener('change', () => setLamp(input.value, scope));
  }

  function setLamp(hex, scope) {
    applySettings({ lamp: hex.toLowerCase() });
    document.querySelectorAll('.swatches').forEach((w) => {
      let matched = false;
      w.querySelectorAll('[data-lamp]').forEach((b) => {
        const on = b.dataset.lamp.toLowerCase() === settings.lamp;
        matched = matched || on;
        b.setAttribute('aria-pressed', String(on));
      });
      const c = w.querySelector('.custom');
      c.setAttribute('aria-pressed', String(!matched));
      c.style.setProperty('--c', settings.lamp);
      c.querySelector('input').value = settings.lamp;
    });
  }

  let lampPop = null;
  function closeLampPop() {
    if (!lampPop) return;
    lampPop.remove();
    lampPop = null;
    document.removeEventListener('pointerdown', onLampOutside, true);
    document.removeEventListener('keydown', onLampKey, true);
  }
  function onLampOutside(e) {
    if (lampPop && !lampPop.contains(e.target) && !e.target.closest('[data-act="lamp"]')) closeLampPop();
  }
  function onLampKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeLampPop(); focusKeys(); }
  }
  function openLampPop(anchor) {
    if (lampPop) { closeLampPop(); return focusKeys(); }
    lampPop = document.createElement('div');
    lampPop.className = 'lamp-pop';
    lampPop.setAttribute('role', 'dialog');
    lampPop.setAttribute('aria-label', 'Lamp colour');
    lampPop.innerHTML = `<div class="lamp-pop-head"><span>Lamp</span><span class="lamp-hex">${settings.lamp}</span></div>${lampSwatches(settings.lamp)}`;
    document.body.appendChild(lampPop);
    const r = anchor.getBoundingClientRect();
    const w = lampPop.offsetWidth;
    lampPop.style.top = `${r.bottom + 8}px`;
    lampPop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    bindSwatches(lampPop);
    const hex = lampPop.querySelector('.lamp-hex');
    lampPop.querySelector('input[type="color"]').addEventListener('input', (e) => { hex.textContent = e.target.value; });
    lampPop.addEventListener('click', () => { hex.textContent = settings.lamp; });
    setTimeout(() => {
      document.addEventListener('pointerdown', onLampOutside, true);
      document.addEventListener('keydown', onLampKey, true);
    });
    lampPop.querySelector('[aria-pressed="true"]')?.focus();
  }

  function renderAll() {
    paper.renderAll(lines, row + 1);
    buildScale();
  }

  /* ---------------------------------------------------------------- */
  /* Model                                                             */
  /* ---------------------------------------------------------------- */
  function lineAt(r) {
    while (lines.length <= r) lines.push([]);
    const l = lines[r];
    for (let i = 0; i < l.length; i++) if (l[i] === undefined) l[i] = null;
    return l;
  }
  const isBlank = (cell) => !cell || !cell.length || cell[cell.length - 1][0] === ' ';

  function changed() {
    dirty = true;
    setSaveState('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1200);
    updateStats();
  }

  function ensurePageFor(r) {
    const before = paper.sheets.length;
    paper.ensurePages(Math.max(before, Math.floor(r / settings.linesPerPage) + 1));
    return paper.sheets.length > before;
  }

  function animateStrike() {
    lamp.classList.remove('hit');
    void lamp.offsetWidth; // restart animation
    lamp.classList.add('hit');
    editorEl.classList.add('typing');
    if (view === 'carriage') {
      roll.classList.remove('jolt');
      void roll.offsetWidth;
      roll.classList.add('jolt');
    }
  }

  function ringBellIfNeeded(prevCol) {
    const mark = settings.cols - BELL_BEFORE;
    if (prevCol < mark && col >= mark) setTimeout(() => sound.bell(), 30);
  }

  function lockAtMargin() {
    sound.lock();
    desk.classList.remove('shake');
    void desk.offsetWidth;
    desk.classList.add('shake');
    if (!warnedMargin) {
      warnedMargin = true;
      toast('Carriage locked at the right margin — press Return.');
    }
  }

  function strike(ch) {
    if (ch === '\n' || ch === '\r') return carriageReturn(true);
    if (ch === '\t') return tab();
    if (col >= settings.cols) {
      if (settings.margin === 'wrap') {
        if (ch === ' ') return carriageReturn(true);
        if (!wrapWord()) return lockAtMargin();
      } else {
        return lockAtMargin();
      }
    }
    const prev = col;
    if (ch === ' ') {
      sound.space();
      col++;
    } else {
      const line = lineAt(row);
      while (line.length < col) line.push(null);
      const cell = line[col] ? line[col] : [];
      if (cell.length >= 8) cell.shift();
      cell.push([ch, settings.ink]);
      line[col] = cell;
      paper.renderLine(row, line);
      sound.key(/[A-Z#@%&$WM]/.test(ch));
      animateStrike();
      col++;
      changed();
    }
    ringBellIfNeeded(prev);
    place('step');
    followCaret();
  }

  function wrapWord() {
    const line = lineAt(row);
    let start = col;
    while (start > 0 && !isBlank(line[start - 1])) start--;
    if (start === 0 || row >= MAX_ROWS) return false;
    const word = line.slice(start, col);
    for (let i = start; i < col; i++) line[i] = null;
    paper.renderLine(row, line);
    carriageReturn(true, true);
    const next = lineAt(row);
    word.forEach((cell, i) => {
      while (next.length < i) next.push(null);
      next[i] = next[i] ? next[i].concat(cell || []) : cell;
    });
    col = word.length;
    paper.renderLine(row, next);
    changed();
    return true;
  }

  function carriageReturn(feed = true, quiet = false) {
    const spacing = settings.spacing || 1;
    col = 0;
    if (feed) {
      if (row + spacing > MAX_ROWS) return lockAtMargin();
      row += spacing;
      const newPage = ensurePageFor(row);
      if (!quiet) {
        if (newPage) {
          sound.feed();
          toast(`Fresh sheet — page ${Math.floor(row / settings.linesPerPage) + 1}`);
        } else sound.ret();
      }
    } else if (!quiet) sound.ret();
    place('ret');
    followCaret();
    persistCursorSoon();
  }

  function backspace() {
    if (col === 0) {
      sound.lock();
      return;
    }
    col--;
    if (settings.corrections === 'tape') {
      const line = lineAt(row);
      const cell = line[col];
      if (cell && cell.length) {
        cell.pop();
        if (!cell.length) line[col] = null;
        paper.renderLine(row, line);
        changed();
        sound.back();
        sound.space();
      } else sound.back();
    } else sound.back();
    place('step');
    followCaret();
    persistCursorSoon();
  }

  function tab() {
    const next = Math.min(settings.cols, (Math.floor(col / TAB) + 1) * TAB);
    if (next === col) return lockAtMargin();
    const prev = col;
    col = next;
    sound.space();
    ringBellIfNeeded(prev);
    place('jump');
    followCaret();
    persistCursorSoon();
  }

  function rollPlaten(delta) {
    const next = Math.max(0, Math.min(MAX_ROWS, row + delta));
    if (next === row) return;
    row = next;
    const newPage = ensurePageFor(row);
    if (newPage) sound.feed();
    else sound.roll();
    place('roll');
    followCaret();
    persistCursorSoon();
  }

  function moveCol(delta) {
    const next = Math.max(0, Math.min(settings.cols, col + delta));
    if (next === col) return sound.lock();
    const prev = col;
    col = next;
    delta > 0 ? sound.space() : sound.back();
    ringBellIfNeeded(prev);
    place('step');
    followCaret();
    persistCursorSoon();
  }

  function setCursor(r, c) {
    row = Math.max(0, Math.min(MAX_ROWS, r));
    col = Math.max(0, Math.min(settings.cols, c));
    ensurePageFor(row);
    sound.ret();
    place('jump');
    persistCursorSoon();
  }

  let cursorTimer = null;
  function persistCursorSoon() {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      if (!dirty) {
        dirty = true;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 1500);
      }
    }, 800);
  }

  /* auto-typing queue for pasted text */
  function enqueue(text) {
    const chars = Array.from(text.replace(/\r\n?/g, '\n')).slice(0, 20000);
    queue.push(...chars);
    if (!queueTimer) pump();
  }
  function pump() {
    if (destroyed) return;
    const ch = queue.shift();
    if (ch === undefined) {
      queueTimer = null;
      desk.classList.remove('autotyping');
      return;
    }
    desk.classList.add('autotyping');
    strike(ch);
    queueTimer = setTimeout(pump, ch === '\n' ? 260 : ch === ' ' ? 30 : 38 + Math.random() * 30);
  }
  function type(text) {
    if (queueTimer) return enqueue(text);
    for (const ch of Array.from(text)) strike(ch);
  }

  /* ---------------------------------------------------------------- */
  /* Saving                                                            */
  /* ---------------------------------------------------------------- */
  function setSaveState(s) {
    saveState.dataset.state = s;
    saveState.textContent = { dirty: 'Unsaved', saving: 'Saving…', saved: 'Saved', error: 'Offline — retrying' }[s];
  }

  function snapshot() {
    let last = lines.length - 1;
    while (last >= 0 && !(lines[last] || []).some((c) => c && c.length)) last--;
    const out = [];
    for (let r = 0; r <= last; r++) {
      const l = (lines[r] || []).map((c) => (c && c.length ? c : null));
      while (l.length && l[l.length - 1] === null) l.pop();
      out.push(l);
    }
    return {
      title,
      content: { v: 1, lines: out },
      settings: { ...settings, cursor: { row, col } },
    };
  }

  async function save(opts = {}) {
    clearTimeout(saveTimer);
    if (!dirty || destroyed && !opts.keepalive) return;
    if (saving) {
      saveTimer = setTimeout(save, 600);
      return;
    }
    saving = true;
    dirty = false;
    setSaveState('saving');
    try {
      await api.saveDoc(doc.id, snapshot(), opts);
      if (!dirty) setSaveState('saved');
    } catch (e) {
      dirty = true;
      if (e.status === 401) {
        toast('Your session expired. Please sign in again.');
        navigate('#/login');
        return;
      }
      setSaveState('error');
      saveTimer = setTimeout(save, 4000);
    } finally {
      saving = false;
    }
  }

  function flush() {
    if (dirty) save({ keepalive: true });
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */
  function resetKeys() {
    keys.value = SENTINEL;
    keys.setSelectionRange(SENTINEL.length, SENTINEL.length);
  }

  function focusKeys() {
    keys.focus({ preventScroll: true });
    resetKeys();
    sound.unlock();
  }

  let composing = false;
  keys.addEventListener('compositionstart', () => { composing = true; });
  keys.addEventListener('compositionend', () => {
    composing = false;
    readKeys();
  });
  keys.addEventListener('input', () => {
    if (!composing) readKeys();
  });
  function readKeys() {
    const v = keys.value;
    if (v.length < SENTINEL.length && !v.replace(/​/g, '').length) {
      backspace();
    } else {
      const text = v.replace(/​/g, '');
      if (text) type(text);
    }
    resetKeys();
  }

  const REPEATABLE = new Set([' ', 'x', 'X', '-', '_', '.', '=', '*']);
  keys.addEventListener('keydown', (e) => {
    sound.unlock();
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      dirty = true;
      save();
      return;
    }
    if (mod || e.altKey && e.key.length > 1) return;
    if (composing || e.isComposing) return;
    switch (e.key) {
      case 'Enter': e.preventDefault(); if (!e.repeat) type('\n'); return;
      case 'Backspace': e.preventDefault(); if (queueTimer) return; backspace(); return;
      case 'Tab': e.preventDefault(); type('\t'); return;
      case 'ArrowUp': e.preventDefault(); rollPlaten(-1); return;
      case 'ArrowDown': e.preventDefault(); rollPlaten(1); return;
      case 'ArrowLeft': e.preventDefault(); moveCol(-1); return;
      case 'ArrowRight': e.preventDefault(); moveCol(1); return;
      case 'Home': e.preventDefault(); if (col) carriageReturn(false); return;
      case 'PageDown': e.preventDefault(); rollPlaten(settings.linesPerPage - (row % settings.linesPerPage)); return;
      case 'PageUp': e.preventDefault(); rollPlaten(-((row % settings.linesPerPage) || settings.linesPerPage)); return;
      case 'Escape': keys.blur(); return;
      default:
        if (e.repeat && e.key.length === 1 && !REPEATABLE.has(e.key)) e.preventDefault();
    }
  });

  keys.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) {
      if (text.length > 400) toast(`Auto-typing ${text.length.toLocaleString()} characters…`);
      enqueue(text);
    }
  });
  keys.addEventListener('focus', () => desk.classList.add('focused'));
  keys.addEventListener('blur', () => desk.classList.remove('focused'));

  /* pointer: click to position, wheel / drag to roll or scroll */
  let drag = null;
  let wheelAcc = 0;
  desk.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, startScroll: scrollY, startRow: row, moved: false, id: e.pointerId };
  });
  desk.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 6 || Math.abs(e.clientX - drag.x) > 6) drag.moved = true;
    if (!drag.moved || e.pointerType === 'mouse') return;
    if (view === 'page') {
      scrollY = Math.max(0, Math.min(maxScroll(), drag.startScroll - dy / geo.s));
      place('none');
    } else {
      const target = drag.startRow - Math.round(dy / geo.s / LH);
      if (target !== row) rollPlaten(target - row);
    }
  });
  desk.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (!d || d.moved || e.target.closest('.ed-status')) {
      focusKeys();
      return;
    }
    const sheets = paper.el.getBoundingClientRect();
    if (e.clientY >= sheets.top && e.clientY <= sheets.bottom && e.clientX >= sheets.left && e.clientX <= sheets.right) {
      const hit = paper.hit((e.clientX - sheets.left) / geo.s, (e.clientY - sheets.top) / geo.s);
      if (hit.row !== row || hit.col !== col) setCursor(hit.row, hit.col);
    }
    focusKeys();
  });
  desk.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (view === 'page') {
        scrollY = Math.max(0, Math.min(maxScroll(), scrollY + e.deltaY / geo.s));
        place('none');
        return;
      }
      wheelAcc += e.deltaY;
      const step = 70;
      while (Math.abs(wheelAcc) >= step) {
        rollPlaten(wheelAcc > 0 ? 1 : -1);
        wheelAcc -= Math.sign(wheelAcc) * step;
      }
    },
    { passive: false }
  );

  /* chrome fades away while typing, returns when the mouse moves */
  let lastMove = null;
  editorEl.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (lastMove && Math.hypot(e.clientX - lastMove.x, e.clientY - lastMove.y) < 12) return;
    lastMove = { x: e.clientX, y: e.clientY };
    editorEl.classList.remove('typing');
  });

  /* ---------------------------------------------------------------- */
  /* Toolbar                                                           */
  /* ---------------------------------------------------------------- */
  titleInput.addEventListener('input', () => {
    title = titleInput.value;
    document.title = `${title || 'Untitled'} — Naoko`;
    changed();
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      if (!titleInput.value.trim()) titleInput.value = title = 'Untitled';
      focusKeys();
    }
  });

  function setView(v) {
    if (view === v) return;
    view = v;
    try { localStorage.setItem('naoko:view', v); } catch { /* ignore */ }
    if (v === 'page') {
      const { y } = paper.cellPos(row, col);
      measure();
      scrollY = Math.max(0, Math.min(maxScroll(), y - geo.h * 0.4));
    } else measure();
    updateChrome();
    place('jump');
    if (v === 'carriage') motes.start(); else motes.stop();
    focusKeys();
  }

  function applySettings(patch) {
    const relayout = ['cols', 'face', 'paper', 'linesPerPage'].some((k) => patch[k] !== undefined && patch[k] !== settings[k]);
    settings = { ...settings, ...patch };
    sound.configure({ enabled: settings.sound, volume: settings.volume });
    if (relayout) {
      col = Math.min(col, settings.cols);
      paper.setSettings(settings);
      renderAll();
      measure();
    }
    updateChrome();
    place('jump');
    changed();
  }

  root.querySelector('.ed-bar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.view) return setView(b.dataset.view);
    switch (b.dataset.act) {
      case 'home': return navigate('#/docs');
      case 'ink':
        applySettings({ ink: settings.ink ? 0 : 1 });
        sound.roll();
        toast(settings.ink ? 'Ribbon shifted to red' : 'Ribbon shifted to black');
        return focusKeys();
      case 'lamp': return openLampPop(b);
      case 'sound':
        applySettings({ sound: !settings.sound });
        return focusKeys();
      case 'settings': return openSettings();
      case 'share': return openShare();
      case 'export': return openExport(b);
    }
  });

  function openSettings() {
    const opt = (name, value, label, cur) =>
      `<label class="chip"><input type="radio" name="${name}" value="${value}" ${String(cur) === String(value) ? 'checked' : ''}/><span>${label}</span></label>`;
    const m = modal(`
      <h2>Typewriter</h2>
      <form class="settings">
        <fieldset><legend>Typeface</legend>
          ${opt('face', 'elite', '<span style="font-family:\'Special Elite\'">Elite</span>', settings.face)}
          ${opt('face', 'prime', '<span style="font-family:\'Courier Prime\'">Pica</span>', settings.face)}
        </fieldset>
        <fieldset><legend>Paper</legend>
          ${opt('paper', 'ivory', 'Ivory bond', settings.paper)}
          ${opt('paper', 'white', 'Bright white', settings.paper)}
          ${opt('paper', 'manila', 'Manila', settings.paper)}
          ${opt('paper', 'onion', 'Onionskin', settings.paper)}
        </fieldset>
        <fieldset><legend>Line width</legend>
          ${[50, 60, 65, 72, 80].map((c) => opt('cols', c, `${c}`, settings.cols)).join('')}
        </fieldset>
        <fieldset><legend>Line spacing</legend>
          ${opt('spacing', 1, 'Single', settings.spacing)}
          ${opt('spacing', 2, 'Double', settings.spacing)}
        </fieldset>
        <fieldset><legend>Backspace</legend>
          ${opt('corrections', 'none', 'Purist — moves carriage only', settings.corrections)}
          ${opt('corrections', 'tape', 'Correction tape — lifts off', settings.corrections)}
        </fieldset>
        <fieldset><legend>Right margin</legend>
          ${opt('margin', 'lock', 'Lock with bell', settings.margin)}
          ${opt('margin', 'wrap', 'Auto-return words', settings.margin)}
        </fieldset>
        <fieldset class="lamp-field"><legend>Lamp colour</legend>
          ${lampSwatches(settings.lamp)}
        </fieldset>
        <fieldset><legend>Sound</legend>
          <label class="switch"><input type="checkbox" name="sound" ${settings.sound ? 'checked' : ''}/><span>Key sounds</span></label>
          <input type="range" name="volume" min="0" max="1" step="0.05" value="${settings.volume}" aria-label="Volume" />
        </fieldset>
      </form>`, { onClose: focusKeys });
    bindSwatches(m.el.querySelector('.lamp-field'));
    m.el.querySelector('form').addEventListener('change', (e) => {
      const t = e.target;
      if (t.type === 'color') return;
      let v = t.type === 'checkbox' ? t.checked : t.value;
      if (['cols', 'spacing'].includes(t.name)) v = Number(v);
      if (t.name === 'volume') v = Number(v);
      applySettings({ [t.name]: v });
      if (t.name === 'volume' || t.name === 'sound') sound.key();
    });
  }

  async function openShare() {
    const linkFor = (tok) => `${location.origin}/#/s/${tok}`;
    let token = doc.shareToken;
    const m = modal(`
      <h2>Share “${escapeHtml(title || 'Untitled')}”</h2>
      <p class="muted">Anyone with the link can read the typed pages. Only you can type on them.</p>
      <label class="switch big"><input type="checkbox" class="share-toggle" ${token ? 'checked' : ''}/><span>Link sharing</span></label>
      <div class="share-row" ${token ? '' : 'hidden'}>
        <input class="input share-link" readonly value="${token ? linkFor(token) : ''}" />
        <button class="btn" data-copy>${icons.copy}<span>Copy</span></button>
      </div>`, { onClose: focusKeys });
    const row_ = m.el.querySelector('.share-row');
    const linkInput = m.el.querySelector('.share-link');
    m.el.querySelector('.share-toggle').addEventListener('change', async (e) => {
      try {
        const r = await api.share(doc.id, e.target.checked);
        token = doc.shareToken = r.shareToken;
        row_.hidden = !token;
        linkInput.value = token ? linkFor(token) : '';
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast(err.message);
      }
    });
    m.el.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(linkInput.value);
        toast('Link copied');
      } catch {
        linkInput.select();
      }
    });
  }

  function openExport(anchor) {
    menu(anchor, [
      { icon: icons.download, label: 'Download as .txt', run: downloadTxt },
      { icon: icons.print, label: 'Print / save as PDF', run: () => window.print() },
    ]);
  }

  function downloadTxt() {
    const blob = new Blob([linesToText(lines) + '\n'], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(title || 'Untitled').replace(/[^\w\- ]+/g, '').trim() || 'naoko'}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */
  const onResize = () => { measure(); place('none'); };
  const onVis = () => {
    if (document.visibilityState === 'hidden') { flush(); motes.stop(); } else motes.start();
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', onVis);

  document.title = `${title || 'Untitled'} — Naoko`;
  renderAll();
  updateChrome();
  updateStats();
  measure();
  if (view === 'page') {
    const { y } = paper.cellPos(row, col);
    scrollY = Math.max(0, Math.min(maxScroll(), y - geo.h * 0.4));
  }
  place('none');
  motes.start();
  resetKeys();
  requestAnimationFrame(() => {
    focusKeys();
    document.fonts && document.fonts.ready.then(() => !destroyed && place('none'));
  });
  if (!localStorage.getItem('naoko:welcomed')) {
    try { localStorage.setItem('naoko:welcomed', '1'); } catch { /* ignore */ }
    setTimeout(() => toast('Just start typing. Listen for the bell near the margin.'), 600);
  }

  return {
    async destroy() {
      destroyed = true;
      clearTimeout(queueTimer);
      closeLampPop();
      motes.stop();
      document.body.style.removeProperty('--lamp');
      document.body.style.removeProperty('--lamp-rgb');
      window.removeEventListener('resize', onResize);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVis);
      if (dirty) {
        dirty = true;
        await save({ keepalive: true }).catch(() => {});
      }
    },
  };
}
