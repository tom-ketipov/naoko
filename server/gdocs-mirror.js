'use strict';
/**
 * One-way mirror: Naoko document -> Google Doc.
 *
 * Naoko stays the source of truth. A few seconds after the writer pauses, the
 * changed text is pushed to the Google Doc as a minimal edit: one delete and
 * one insert covering only the changed stretch, then restyling of the touched
 * lines. Untouched text (and any comments anchored to it) stays put.
 *
 * Document model in Google Docs: one paragraph per typewriter row, in
 * Courier Prime 12 pt (10 characters per inch, like pica). Each new sheet
 * starts with "page break before"; red ribbon text is red. The body always
 * ends with one extra empty paragraph, so no edit or style range ever has to
 * touch the document's undeletable final newline.
 *
 * Every incremental update carries the revision it was computed against. If
 * someone edited the Google Doc directly, Google rejects the update and the
 * mirror rewrites the whole body instead.
 */

const FONT = { weightedFontFamily: { fontFamily: 'Courier Prime', weight: 400 }, fontSize: { magnitude: 12, unit: 'PT' } };
const BLACK = { color: { rgbColor: { red: 0.12, green: 0.11, blue: 0.1 } } };
const RED = { color: { rgbColor: { red: 0.68, green: 0.16, blue: 0.11 } } };
const DEBOUNCE_MS = 2500;
// control characters and line/paragraph separators would break the one-paragraph-per-row mapping
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]');
const RETRY_MS = [10_000, 30_000, 90_000];

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */
/** Typewriter grid -> [{ t: text, r: [[start, end], ...] red runs in UTF-16 offsets }] */
function buildMirror(content, settings) {
  const lpp = settings && Number.isInteger(settings.linesPerPage) ? settings.linesPerPage : 54;
  const rows = (content && Array.isArray(content.lines) && content.lines) || [];
  let last = rows.length - 1;
  while (last >= 0 && !(rows[last] || []).some((c) => c && c.length)) last--;
  const lines = [];
  for (let r = 0; r <= last; r++) {
    let t = '';
    const red = [];
    for (const cell of rows[r] || []) {
      const top = cell && cell.length ? cell[cell.length - 1] : null;
      let ch = top ? String(top[0] || ' ') : ' ';
      if (CONTROL_RE.test(ch)) ch = ' ';
      const start = t.length;
      t += ch;
      if (top && top[1] === 1 && ch !== ' ') {
        const prev = red[red.length - 1];
        if (prev && prev[1] === start) prev[1] = t.length;
        else red.push([start, t.length]);
      }
    }
    t = t.replace(/\s+$/, '');
    lines.push({ t, r: red.map(([a, b]) => [a, Math.min(b, t.length)]).filter(([a, b]) => b > a) });
  }
  return { lines, lpp };
}

const docText = (m) => m.lines.map((l) => l.t).join('\n') + '\n';

function lineStarts(m) {
  const starts = new Array(m.lines.length);
  let idx = 1; // body content starts at index 1
  for (let i = 0; i < m.lines.length; i++) {
    starts[i] = idx;
    idx += m.lines[i].t.length + 1;
  }
  return starts;
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** Common prefix / suffix lengths that never split a surrogate pair. */
function textDiff(a, b) {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && p < max && isLow(a.charCodeAt(p)) && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && isLow(b.charCodeAt(b.length - s)) && b.length - s - 1 >= p && isHigh(b.charCodeAt(b.length - s - 1))) s--;
  return { p, s };
}

/** Index of the line containing UTF-16 offset `off` of docText (0-based, excluding the body's start index). */
function lineAtOffset(starts, off) {
  let lo = 0;
  let hi = starts.length - 1;
  const idx = off + 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function styleRequests(m, starts, affected) {
  const reqs = [];
  const sorted = [...affected].filter((i) => i >= 0 && i < m.lines.length).sort((a, b) => a - b);
  // group into contiguous runs
  const runs = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }
  for (const [a, b] of runs) {
    const start = starts[a];
    const textEnd = starts[b] + m.lines[b].t.length;
    const paraEnd = textEnd + 1;
    reqs.push({
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: paraEnd },
        paragraphStyle: {
          lineSpacing: 100,
          spaceAbove: { magnitude: 0, unit: 'PT' },
          spaceBelow: { magnitude: 0, unit: 'PT' },
          pageBreakBefore: false,
        },
        fields: 'lineSpacing,spaceAbove,spaceBelow,pageBreakBefore',
      },
    });
    for (let i = a; i <= b; i++) {
      if (i > 0 && i % m.lpp === 0) {
        reqs.push({
          updateParagraphStyle: {
            range: { startIndex: starts[i], endIndex: starts[i] + m.lines[i].t.length + 1 },
            paragraphStyle: { pageBreakBefore: true },
            fields: 'pageBreakBefore',
          },
        });
      }
    }
    if (textEnd > start) {
      reqs.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: textEnd },
          textStyle: { ...FONT, foregroundColor: BLACK, bold: false, italic: false, underline: false },
          fields: 'weightedFontFamily,fontSize,foregroundColor,bold,italic,underline',
        },
      });
    }
    for (let i = a; i <= b; i++) {
      for (const [ra, rb] of m.lines[i].r) {
        reqs.push({
          updateTextStyle: {
            range: { startIndex: starts[i] + ra, endIndex: starts[i] + rb },
            textStyle: { foregroundColor: RED },
            fields: 'foregroundColor',
          },
        });
      }
    }
  }
  return reqs;
}

/** Requests to turn the mirrored `prev` into `next`. Returns [] when nothing changed. */
function planIncremental(prev, next) {
  const a = docText(prev);
  const b = docText(next);
  const reqs = [];
  const affected = new Set();
  if (a !== b) {
    const { p, s } = textDiff(a, b);
    const delStart = 1 + p;
    const delEnd = 1 + a.length - s;
    const ins = b.slice(p, b.length - s);
    if (delEnd > delStart) reqs.push({ deleteContentRange: { range: { startIndex: delStart, endIndex: delEnd } } });
    if (ins) reqs.push({ insertText: { location: { index: delStart }, text: ins } });
    const starts = lineStarts(next);
    if (next.lines.length) {
      const first = lineAtOffset(starts, Math.min(p, Math.max(0, b.length - 1)));
      const last = lineAtOffset(starts, Math.max(p, b.length - s - 1));
      // +1: a split paragraph keeps its old paragraph style, so restyle the line after the edit too
      for (let i = first; i <= Math.min(last + 1, next.lines.length - 1); i++) affected.add(i);
    }
  }
  for (let i = 0; i < next.lines.length; i++) {
    const o = prev.lines[i];
    const n = next.lines[i];
    if (!o || o.t !== n.t || JSON.stringify(o.r) !== JSON.stringify(n.r)) affected.add(i);
  }
  if (!reqs.length && !affected.size) return [];
  return reqs.concat(styleRequests(next, lineStarts(next), affected));
}

/** Requests to replace the whole body (bodyEndIndex = endIndex of the body's last element). */
function planFull(next, bodyEndIndex) {
  const reqs = [];
  if (bodyEndIndex - 1 > 1) reqs.push({ deleteContentRange: { range: { startIndex: 1, endIndex: bodyEndIndex - 1 } } });
  reqs.push({ insertText: { location: { index: 1 }, text: docText(next) } });
  reqs.push({
    updateDocumentStyle: {
      documentStyle: {
        marginTop: { magnitude: 72, unit: 'PT' },
        marginBottom: { magnitude: 72, unit: 'PT' },
        marginLeft: { magnitude: 72, unit: 'PT' },
        marginRight: { magnitude: 72, unit: 'PT' },
        pageSize: { width: { magnitude: 612, unit: 'PT' }, height: { magnitude: 792, unit: 'PT' } },
      },
      fields: 'marginTop,marginBottom,marginLeft,marginRight,pageSize',
    },
  });
  const all = new Set(next.lines.map((_, i) => i));
  return reqs.concat(styleRequests(next, lineStarts(next), all));
}

/* ------------------------------------------------------------------ */
/* Sync queue                                                          */
/* ------------------------------------------------------------------ */
function createMirror({ store, google }) {
  const jobs = new Map(); // docId -> { userId, timer, running, again, attempt }

  const job = (docId, userId) => {
    let j = jobs.get(docId);
    if (!j) { j = { userId, timer: null, running: false, again: false, attempt: 0 }; jobs.set(docId, j); }
    j.userId = userId;
    return j;
  };

  function schedule(docId, userId, delay = DEBOUNCE_MS) {
    const j = job(docId, userId);
    if (j.running) { j.again = true; return; }
    clearTimeout(j.timer);
    j.timer = setTimeout(() => { j.timer = null; run(docId).catch((e) => console.error('[gdocs] sync failed', e)); }, delay);
    j.timer.unref && j.timer.unref();
  }

  function pending(docId) {
    const j = jobs.get(docId);
    return !!(j && (j.timer || j.running));
  }

  async function run(docId) {
    const j = jobs.get(docId);
    if (!j) return;
    if (j.running) { j.again = true; return; }
    j.running = true;
    const { userId } = j;
    try {
      await syncOnce(docId, userId);
      j.attempt = 0;
    } catch (e) {
      await handleError(docId, userId, j, e);
    } finally {
      j.running = false;
      const retryIn = j.retryIn;
      j.retryIn = 0;
      if (j.again || retryIn) { j.again = false; schedule(docId, userId, Math.max(retryIn || 0, 500)); }
      else if (!j.timer) jobs.delete(docId);
    }
  }

  async function syncOnce(docId, userId) {
    const d = await store.getDoc(docId, userId);
    if (!d || !d.gdoc_sync || !d.gdoc_id) return;
    const token = await google.accessToken(store, userId);
    const next = buildMirror(d.content, d.settings);
    const prev = d.gdoc_state && Array.isArray(d.gdoc_state.lines) ? d.gdoc_state : null;
    let revisionId = prev ? prev.revisionId : null;

    let done = false;
    // Shrinking (erasing the last lines) rewrites fully so no stale paragraph styles linger at the end.
    if (prev && prev.lpp === next.lpp && revisionId && next.lines.length >= prev.lines.length) {
      const reqs = planIncremental(prev, next);
      if (!reqs.length) {
        done = true;
      } else {
        try {
          const res = await google.docs.batchUpdate(token, d.gdoc_id, reqs, { requiredRevisionId: revisionId });
          revisionId = (res.writeControl && res.writeControl.requiredRevisionId) || null;
          done = true;
        } catch (e) {
          // 400: the doc changed under us (edited in Google Docs) -> rewrite fully below.
          if (!(e instanceof google.GoogleApiError) || e.status !== 400) throw e;
        }
      }
    }
    if (!done) {
      const doc = await google.docs.get(token, d.gdoc_id, 'revisionId,body(content(endIndex))');
      const content = (doc.body && doc.body.content) || [];
      const end = content.length ? content[content.length - 1].endIndex : 2;
      const res = await google.docs.batchUpdate(token, d.gdoc_id, planFull(next, end), { requiredRevisionId: doc.revisionId });
      revisionId = (res.writeControl && res.writeControl.requiredRevisionId) || null;
    }

    if (!prev || prev.title !== d.title) {
      await google.drive.rename(token, d.gdoc_id, d.title || 'Untitled');
    }
    await store.updateDocGoogle(docId, userId, {
      gdocState: { lines: next.lines, lpp: next.lpp, revisionId, title: d.title },
      gdocSyncedAt: new Date(),
      gdocError: null,
    });
  }

  async function handleError(docId, userId, j, e) {
    if (e instanceof google.GoogleAuthError) {
      await store.updateDocGoogle(docId, userId, { gdocError: e.message });
      return;
    }
    if (e instanceof google.GoogleApiError && (e.status === 404 || e.status === 403)) {
      await store.updateDocGoogle(docId, userId, {
        gdocSync: false,
        gdocId: null,
        gdocState: null,
        gdocError: e.status === 404
          ? 'The Google Doc was deleted. Turn syncing on again to create a new one.'
          : 'Naoko lost access to the Google Doc. Turn syncing on again to create a new one.',
      });
      return;
    }
    const delay = RETRY_MS[Math.min(j.attempt, RETRY_MS.length - 1)];
    j.attempt++;
    const busy = e instanceof google.GoogleApiError && (e.status === 429 || e.status >= 500);
    await store.updateDocGoogle(docId, userId, {
      gdocError: busy ? 'Google is busy — retrying shortly.' : `Sync failed: ${e.message}. Retrying.`,
    });
    if (j.attempt <= RETRY_MS.length) j.retryIn = delay;
  }

  /** Turn mirroring on: create the Google Doc if needed, then sync right away. */
  async function enable(docId, userId) {
    const d = await store.getDoc(docId, userId);
    if (!d) return null;
    let gdocId = d.gdoc_id;
    if (!gdocId) {
      const token = await google.accessToken(store, userId);
      const created = await google.docs.create(token, d.title || 'Untitled');
      gdocId = created.documentId;
    }
    await store.updateDocGoogle(docId, userId, { gdocId, gdocSync: true, gdocState: null, gdocError: null });
    job(docId, userId);
    await run(docId);
    return store.getDoc(docId, userId);
  }

  async function disable(docId, userId) {
    const j = jobs.get(docId);
    if (j) clearTimeout(j.timer);
    jobs.delete(docId);
    return store.updateDocGoogle(docId, userId, { gdocSync: false, gdocError: null });
  }

  return { schedule, enable, disable, pending, run };
}

module.exports = { createMirror, buildMirror, planIncremental, planFull, docText, _textDiff: textDiff };
