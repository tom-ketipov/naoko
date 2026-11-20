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
function showAuth(mode) {
  document.title = 'Nuvio — Typewriter Documents';
  document.body.className = 'page-auth';
  app.innerHTML = `
  <div class="auth">
    <section class="auth-hero">
      <div class="hero-sheet">
        <div class="hero-type" aria-hidden="true"></div>
      </div>
      <div class="hero-platen"></div>
    </section>
    <section class="auth-panel">
      <div class="logo">nuvio<span>.</span></div>
      <p class="tagline">Documents with the soul of a typewriter. Carriage returns, a margin bell, ribbon ink — saved to the cloud.</p>
      <div class="tabs" role="tablist">
        <button role="tab" data-mode="login" aria-selected="${mode === 'login'}">Sign in</button>
        <button role="tab" data-mode="register" aria-selected="${mode === 'register'}">Create account</button>
      </div>
      <form class="auth-form" novalidate>
        <label class="field name-field" ${mode === 'login' ? 'hidden' : ''}><span>Name</span><input class="input" name="name" autocomplete="name" /></label>
        <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" required /></label>
        <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="8" required /></label>
        <p class="form-error" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
      </form>
    </section>
  </div>`;

  // Hero: type a sample line, letter by letter.
  const hero = app.querySelector('.hero-type');
  const sample = 'Dear reader,\n\nThe bell rings near the end of every line.\nThere is no undo. Only the next word.\n\n— N.';
  let i = 0;
  let timer = null;
  const tick = () => {
    if (!app.contains(hero)) return;
    if (i >= sample.length) return;
    const ch = sample[i++];
    hero.innerHTML += ch === '\n' ? '<br>' : `<span style="opacity:${(0.78 + Math.random() * 0.22).toFixed(2)};transform:translateY(${(Math.random() - 0.5).toFixed(2)}px)">${escapeHtml(ch)}</span>`;
    timer = setTimeout(tick, ch === '\n' ? 380 : 50 + Math.random() * 70);
  };
  timer = setTimeout(tick, 500);
  current = { destroy() { clearTimeout(timer); } };

  const form = app.querySelector('.auth-form');
  const err = app.querySelector('.form-error');
  app.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      app.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      app.querySelector('.name-field').hidden = mode === 'login';
      form.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      form.querySelector('[type=submit]').textContent = mode === 'login' ? 'Sign in' : 'Create account';
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
  document.title = 'Your documents — Nuvio';
  document.body.className = 'page-docs';
  app.innerHTML = `
  <div class="docs">
    <header class="topbar">
      <a class="logo sm" href="#/docs">nuvio<span>.</span></a>
      <div class="spacer"></div>
      <span class="who">${escapeHtml(user.name)}</span>
      <button class="icon-btn" data-act="logout" title="Sign out" aria-label="Sign out">${icons.logout}</button>
    </header>
    <section class="docs-new">
      <h2>Feed a new sheet</h2>
      <div class="new-row">
        <button class="new-card" data-new="blank"><div class="mini-sheet"><span class="plus">${icons.plus}</span></div><span>Blank page</span></button>
        <button class="new-card" data-new="letter"><div class="mini-sheet letter"><i></i><i></i><i></i><i></i><i></i></div><span>Letter</span></button>
        <button class="new-card" data-new="manuscript"><div class="mini-sheet ms"><i></i><i></i><i></i><i></i><i></i></div><span>Manuscript</span></button>
        <button class="new-card" data-new="poem"><div class="mini-sheet poem"><i></i><i></i><i></i><i></i></div><span>Poem</span></button>
      </div>
    </section>
    <section class="docs-list">
      <div class="list-head"><h2>Recent documents</h2></div>
      <div class="grid"><div class="loading">Loading…</div></div>
    </section>
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
    if (!docs.length) {
      grid.innerHTML = `<div class="empty"><p>No documents yet.</p><p class="muted">Pick a sheet above and start typing.</p></div>`;
      return;
    }
    grid.innerHTML = docs
      .map(
        (d) => `
      <article class="doc-card" data-id="${d.id}" tabindex="0">
        <div class="doc-thumb"><p>${escapeHtml(d.preview || '')}</p></div>
        <div class="doc-meta">
          <div class="doc-title">${escapeHtml(d.title)}</div>
          <div class="doc-sub">${timeAgo(d.updatedAt)} · ${d.wordCount} words ${d.shared ? `<span class="pill">${icons.link}Shared</span>` : ''}</div>
        </div>
        <button class="icon-btn doc-more" aria-label="More actions">${icons.more}</button>
      </article>`
      )
      .join('');
  } catch (e) {
    if (e.status === 401) { user = null; return navigate('#/login'); }
    grid.innerHTML = `<div class="empty"><p>Couldn’t load documents.</p><p class="muted">${escapeHtml(e.message)}</p></div>`;
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
  const cur = card.querySelector('.doc-title').textContent;
  const m = modal(`<h2>Rename</h2><form><input class="input" name="t" maxlength="120" value="${escapeHtml(cur)}"/>
    <div class="modal-actions"><button type="button" class="btn" data-no>Cancel</button><button class="btn btn-primary">Save</button></div></form>`);
  const f = m.el.querySelector('form');
  f.t.select();
  m.el.querySelector('[data-no]').onclick = () => m.close();
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api.saveDoc(card.dataset.id, { title: f.t.value });
      card.querySelector('.doc-title').textContent = r.doc.title;
      m.close();
    } catch (ex) { toast(ex.message); }
  };
}

async function deleteDoc(card) {
  const name = card.querySelector('.doc-title').textContent;
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
    document.title = `${doc.title} — Nuvio`;
    app.innerHTML = `
      <div class="shared">
        <header class="topbar">
          <a class="logo sm" href="#/">nuvio<span>.</span></a>
          <div class="shared-title"><b>${escapeHtml(doc.title)}</b><span>typed by ${escapeHtml(doc.author)} · ${timeAgo(doc.updatedAt)}</span></div>
          <div class="spacer"></div>
          <button class="icon-btn" data-print title="Print" aria-label="Print">${icons.print}</button>
          <a class="btn btn-primary btn-sm" href="#/${user ? 'docs' : 'register'}">${user ? 'My documents' : 'Try Nuvio'}</a>
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
    app.innerHTML = `<div class="notfound"><div class="logo">nuvio<span>.</span></div><p>${escapeHtml(e.message)}</p><a class="btn" href="#/">Go home</a></div>`;
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
