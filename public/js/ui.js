import { icons } from './icons.js';

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function modal(html, { onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <button class="icon-btn modal-x" aria-label="Close">${icons.close}</button>${html}</div>`;
  document.body.appendChild(wrap);
  const close = () => {
    wrap.classList.add('out');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => wrap.remove(), 160);
    onClose && onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal-x').addEventListener('click', close);
  requestAnimationFrame(() => {
    const f = wrap.querySelector('input:not([type=radio]):not([type=checkbox]), button.btn-primary');
    if (f) f.focus();
  });
  return { el: wrap.querySelector('.modal'), close };
}

export function confirmDialog({ title, body, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(
      `<h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(body)}</p>
       <div class="modal-actions"><button class="btn" data-no>Cancel</button>
       <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(confirm)}</button></div>`,
      { onClose: () => { if (!done) resolve(false); } }
    );
    m.el.querySelector('[data-no]').onclick = () => m.close();
    m.el.querySelector('[data-yes]').onclick = () => { done = true; resolve(true); m.close(); };
  });
}

export function menu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = items
    .map((it, i) => `<button role="menuitem" class="${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon || ''}<span>${escapeHtml(it.label)}</span></button>`)
    .join('');
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.top = `${r.bottom + 6}px`;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  const close = () => {
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => { if (!el.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    close();
    items[Number(b.dataset.i)].run();
  });
  el.querySelector('button').focus();
}

export function timeAgo(iso) {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
