import { api } from './api.js';
import { icons } from './icons.js';
import { mountEditor } from './editor.js';
import { Paper, withDefaults } from './paper.js';
import { toast, escapeHtml, timeAgo, menu, confirmDialog, modal } from './ui.js';
import { sound } from './sound.js';

const app = document.getElementById('app');
let user = null;
let current = null; // active view with destroy()

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function teardown() {
  if (current && current.destroy) {
    const c = current;
    current = null;
    await c.destroy();
  }
  document.body.className = '';
}

async function route() {
  const hash = location.hash || '#/';
  await teardown();
  const shared = hash.match(/^#\/s\/([\w-]+)/);
  if (shared) return showShared(shared[1]);
  if (!user) return showAuth(hash.startsWith('#/register') ? 'register' : 'login');
  const d = hash.match(/^#\/d\/([0-9a-f-]{36})/i);
  if (d) return showEditor(d[1]);
  return showDocs();
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */
const GRID = `<div class="gridlines" aria-hidden="true">${'<i></i>'.repeat(12)}</div>`;
const pad2 = (n) => String(n).padStart(2, '0');

function showAuth(mode) {
  document.title = 'Naoko — Typewriter Documents';
  document.body.className = 'page-auth';
  app.innerHTML = `
  <div class="auth dark">
    ${GRID}
    <header class="nav">
      <a class="wordmark" href="#/">Naoko</a>
      <nav class="nav-links auth-tabs-nav">
        <button data-mode="login" aria-current="${mode === 'login'}">Sign in</button>
        <button data-mode="register" aria-current="${mode === 'register'}">Create account</button>
      </nav>
    </header>
    <main class="auth-main">
      <span class="anno anno-tl mono">Line 01</span>
      <span class="anno anno-tr mono">Col 65 · Margin bell</span>
      <section class="auth-hero">
        <h1 class="display" aria-label="No undo. Only the next word.">
          <span class="l1"></span><span class="l2"></span><span class="l3"></span>
        </h1>
        <p class="lede">A typewriter for the browser. Carriage returns, a margin bell, ribbon ink and paper — saved to the cloud, shared with a link.</p>
      </section>
      <section class="auth-panel">
        <div class="auth-tabs" role="tablist">
          <button role="tab" data-mode="login" aria-selected="${mode === 'login'}">Sign in</button>
          <button role="tab" data-mode="register" aria-selected="${mode === 'register'}">New account</button>
        </div>
        <form class="auth-form" novalidate>
          <label class="field name-field" ${mode === 'login' ? 'hidden' : ''}><span>Name</span><input class="input" name="name" autocomplete="name" /></label>
          <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required /></label>
          <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="8" required /></label>
          <p class="form-error" role="alert"></p>
          <button class="btn btn-primary btn-block" type="submit"><span class="submit-label">${mode === 'login' ? 'Sign in' : 'Create account'}</span><span aria-hidden="true">→</span></button>
        </form>
      </section>
      <span class="anno anno-bl mono">Pica · 10 cpi · 6 lpi</span>
    </main>
    <footer class="foot mono"><span>Naoko · Typewriter documents</span><span>No undo · Only the next word</span><span>© ${new Date().getFullYear()}</span></footer>
  </div>`;

  // Headline types itself, line by line.
  const lines = ['No undo.', 'Only the', 'next word.'];
  const els = [...app.querySelectorAll('.auth-hero .display span')];
  const caret = document.createElement('i');
  caret.className = 'caret';
  let li = 0;
  let ci = 0;
  let timer = null;
  const tick = () => {
    if (!app.contains(els[0])) return;
    if (li >= lines.length) return;
    const el = els[li];
    el.textContent = lines[li].slice(0, ++ci);
    el.appendChild(caret);
    if (ci >= lines[li].length) { li++; ci = 0; if (li < lines.length) { timer = setTimeout(tick, 420); return; } return; }
    timer = setTimeout(tick, 55 + Math.random() * 80);
  };
  timer = setTimeout(tick, 350);
  current = { destroy() { clearTimeout(timer); } };

  const form = app.querySelector('.auth-form');
  const err = app.querySelector('.form-error');
  app.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      app.querySelectorAll('[data-mode]').forEach((x) => {
        const on = x.dataset.mode === mode;
        x.setAttribute(x.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-current', String(on));
      });
      app.querySelector('.name-field').hidden = mode === 'login';
      form.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      form.querySelector('.submit-label').textContent = mode === 'login' ? 'Sign in' : 'Create account';
      err.textContent = '';
      history.replaceState(null, '', mode === 'login' ? '#/login' : '#/register');
    })
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    sound.unlock();
    err.textContent = '';
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const { email, password, name } = form;
      const r = mode === 'login'
        ? await api.login(email.value, password.value)
        : await api.register(name.value, email.value, password.value);
      user = r.user;
      sound.ret();
      navigate('#/docs');
    } catch (ex) {
      err.textContent = ex.message;
      sound.lock();
    } finally {
      btn.disabled = false;
    }
  });
  setTimeout(() => form.email.focus(), 50);
}

/* ------------------------------------------------------------------ */
/* Document list                                                       */
/* ------------------------------------------------------------------ */
async function showDocs() {
  document.title = 'Your documents — Naoko';
  document.body.className = 'page-docs';
  app.innerHTML = `
  <div class="docs">
    ${GRID}
    <header class="nav">
      <a class="wordmark" href="#/docs">Naoko</a>
      <nav class="nav-links">
        <a href="#/docs" aria-current="true">Documents</a>
        <span class="who mono">${escapeHtml(user.name)}</span>
        <button data-act="logout">Sign out</button>
      </nav>
    </header>
    <section class="docs-hero">
      <div class="meta mono"><span class="doc-count">Index · —</span><span>${new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</span></div>
      <h1 class="display"><span>Your</span><span>papers.</span></h1>
    </section>
    <section class="block">
      <div class="block-head mono"><span>Feed a new sheet</span><span>04 templates</span></div>
      <div class="new-row">
        <button class="new-card" data-new="blank"><div class="mini-sheet"><span class="plus">+</span></div><span class="cap mono"><b>01 — Blank</b><span>→</span></span></button>
        <button class="new-card" data-new="letter"><div class="mini-sheet letter"><i></i><i></i><i></i><i></i><i></i></div><span class="cap mono"><b>02 — Letter</b><span>→</span></span></button>
        <button class="new-card" data-new="manuscript"><div class="mini-sheet ms"><i></i><i></i><i></i><i></i><i></i></div><span class="cap mono"><b>03 — Manuscript</b><span>→</span></span></button>
        <button class="new-card" data-new="poem"><div class="mini-sheet poem"><i></i><i></i><i></i><i></i></div><span class="cap mono"><b>04 — Poem</b><span>→</span></span></button>
      </div>
    </section>
    <section class="block">
      <div class="block-head mono"><span>Recent</span><span class="list-count"></span></div>
      <div class="grid"><div class="loading mono">Loading…</div></div>
    </section>
    <footer class="foot mono"><span>Naoko · Typewriter documents</span><span>Paste to auto-type · ⌘S to save</span><span>© ${new Date().getFullYear()}</span></footer>
  </div>`;

  app.querySelector('[data-act="logout"]').onclick = async () => {
    await api.logout().catch(() => {});
    user = null;
    navigate('#/login');
  };
  app.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => createFromTemplate(b.dataset.new)));

  const grid = app.querySelector('.grid');
  try {
    const { docs } = await api.listDocs();
    const n = docs.length;
    app.querySelector('.doc-count').textContent = `Index · ${pad2(n)} document${n === 1 ? '' : 's'}`;
    app.querySelector('.list-count').textContent = n ? `01 / ${pad2(n)}` : '';
    if (!n) {
      grid.innerHTML = `<div class="empty"><h2 class="display">Blank desk.</h2><p class="mono muted">Feed a sheet above and start typing.</p></div>`;
      return;
    }
    grid.innerHTML = docs
      .map(
        (d, i) => `
      <article class="doc-card" data-id="${d.id}" tabindex="0">
        <div class="doc-thumb"><p>${escapeHtml(d.preview || '')}</p></div>
        <div class="doc-meta">
          <div class="doc-title">${pad2(i + 1)} — <span class="t">${escapeHtml(d.title)}</span></div>
          <div class="doc-sub"><span>${timeAgo(d.updatedAt)}</span><span>· ${d.wordCount} words</span>${d.shared ? `<span class="pill">· ${icons.link}Shared</span>` : ''}</div>
        </div>
        <button class="icon-btn doc-more" aria-label="More actions">${icons.more}</button>
      </article>`
      )
      .join('');
  } catch (e) {
    if (e.status === 401) { user = null; return navigate('#/login'); }
    grid.innerHTML = `<div class="empty"><h2 class="display">Jammed.</h2><p class="mono muted">${escapeHtml(e.message)}</p></div>`;
    return;
  }

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.doc-card');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('.doc-more')) {
      e.stopPropagation();
      return menu(e.target.closest('.doc-more'), [
        { icon: icons.edit, label: 'Rename', run: () => renameDoc(card) },
        { icon: icons.trash, label: 'Delete', danger: true, run: () => deleteDoc(card) },
      ]);
    }
    navigate(`#/d/${id}`);
  });
  grid.addEventListener('keydown', (e) => {
    const card = e.target.closest('.doc-card');
    if (card && e.key === 'Enter' && e.target === card) navigate(`#/d/${card.dataset.id}`);
  });
}

function renameDoc(card) {
  const cur = card.querySelector('.doc-title .t').textContent;
  const m = modal(`<h2>Rename</h2><form><input class="input" name="t" maxlength="120" value="${escapeHtml(cur)}"/>
    <div class="modal-actions"><button type="button" class="btn" data-no>Cancel</button><button class="btn btn-primary">Save</button></div></form>`);
  const f = m.el.querySelector('form');
  f.t.select();
  m.el.querySelector('[data-no]').onclick = () => m.close();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api.saveDoc(card.dataset.id, { title: f.t.value });
      card.querySelector('.doc-title .t').textContent = r.doc.title;
      m.close();
    } catch (ex) { toast(ex.message); }
  };
}

async function deleteDoc(card) {
  const name = card.querySelector('.doc-title .t').textContent;
  const ok = await confirmDialog({ title: 'Delete document?', body: `“${name}” will be permanently deleted. This can’t be undone.`, confirm: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api.deleteDoc(card.dataset.id);
    card.remove();
    toast('Document deleted');
  } catch (ex) { toast(ex.message); }
}

/* Templates are pre-typed with the typewriter's own cell model. */
function typed(text, ink = 0) {
  return text.split('\n').map((l) => Array.from(l).map((ch) => (ch === ' ' ? null : [[ch, ink]])));
}
function createFromTemplate(kind) {
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const tpl = {
    blank: { title: 'Untitled', lines: [[]], cursor: { row: 0, col: 0 }, settings: {} },
    letter: {
      title: 'Letter',
      lines: typed(`${' '.repeat(40)}${date}\n\n\n\nDear \n\n`),
      cursor: { row: 4, col: 5 },
      settings: {},
    },
    manuscript: {
      title: 'Manuscript',
      lines: typed(`${' '.repeat(24)}CHAPTER ONE\n\n\n`),
      cursor: { row: 4, col: 5 },
      settings: { spacing: 2, face: 'prime' },
    },
    poem: { title: 'Poem', lines: [[]], cursor: { row: 0, col: 10 }, settings: { cols: 50 } },
  }[kind];
  api
    .createDoc({ title: tpl.title, content: { v: 1, lines: tpl.lines }, settings: { ...tpl.settings, cursor: tpl.cursor } })
    .then(({ doc }) => {
      sound.unlock();
      sound.feed();
      navigate(`#/d/${doc.id}`);
    })
    .catch((e) => toast(e.message));
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */
async function showEditor(id) {
  document.body.className = 'page-editor';
  app.innerHTML = `<div class="boot"><div class="boot-mark">N</div></div>`;
  try {
    const { doc } = await api.getDoc(id);
    if (!location.hash.includes(id)) return;
    current = mountEditor(app, { doc, user, navigate });
  } catch (e) {
    if (e.status === 401) { user = null; return navigate('#/login'); }
    toast(e.message);
    navigate('#/docs');
  }
}

/* ------------------------------------------------------------------ */
/* Shared, read-only                                                   */
/* ------------------------------------------------------------------ */
async function showShared(token) {
  document.body.className = 'page-shared';
  app.innerHTML = `<div class="boot"><div class="boot-mark">N</div></div>`;
  try {
    const { doc } = await api.shared(token);
    document.title = `${doc.title} — Naoko`;
    app.innerHTML = `
      <div class="shared dark">
        <header class="nav">
          <a class="wordmark" href="#/">Naoko</a>
          <div class="shared-title"><b>${escapeHtml(doc.title)}</b><span>Typed by ${escapeHtml(doc.author)} · ${timeAgo(doc.updatedAt)}</span></div>
          <nav class="nav-links">
            <button data-print>Print</button>
            <a href="#/${user ? 'docs' : 'register'}" aria-current="true">${user ? 'My documents' : 'Try Naoko'} →</a>
          </nav>
        </header>
        <main class="shared-desk"><div class="shared-stage"><div class="sheets"></div></div></main>
      </div>`;
    const settings = withDefaults(doc.settings);
    const paper = new Paper(app.querySelector('.sheets'), settings);
    paper.renderAll(doc.content.lines || []);
    const stage = app.querySelector('.shared-stage');
    const fit = () => {
      stage.style.zoom = Math.min(1, (window.innerWidth - 24) / paper.sheetW);
    };
    paper.el.style.setProperty('--print-zoom', String(816 / paper.sheetW));
    fit();
    window.addEventListener('resize', fit);
    app.querySelector('[data-print]').onclick = () => window.print();
    current = { destroy() { window.removeEventListener('resize', fit); } };
  } catch (e) {
    app.innerHTML = `<div class="notfound dark"><span class="mono">Error · 404</span><h1 class="display">Page<br>not found.</h1><p class="mono" style="opacity:.6">${escapeHtml(e.message)}</p><a class="arrow-link" href="#/">Go home →</a></div>`;
  }
}

/* ------------------------------------------------------------------ */
window.addEventListener('hashchange', route);
(async () => {
  try {
    const r = await api.me();
    user = r.user;
  } catch {
    user = null;
  }
  route();
})();
