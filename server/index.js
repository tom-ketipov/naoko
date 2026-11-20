'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { createStore } = require('./db');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'naoko_session';
const SESSION_DAYS = 30;
const MAX_LINES = 5000;
const MAX_COLS = 120;

const store = createStore();
const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Tiny in-memory rate limiter for auth endpoints. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const key = req.ip;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
    next();
  };
}

/** Validate and normalise the typewriter document model. */
function sanitizeContent(content) {
  if (!content || typeof content !== 'object' || !Array.isArray(content.lines)) {
    throw httpError(400, 'Invalid document content');
  }
  if (content.lines.length > MAX_LINES) throw httpError(413, 'Document too long');
  const lines = content.lines.map((line) => {
    if (!Array.isArray(line)) return [];
    return line.slice(0, MAX_COLS).map((cell) => {
      if (!Array.isArray(cell) || cell.length === 0) return null;
      const strikes = cell
        .slice(0, 8)
        .filter((s) => Array.isArray(s) && typeof s[0] === 'string' && s[0].length > 0)
        .map((s) => [Array.from(s[0])[0], s[1] === 1 ? 1 : 0]);
      return strikes.length ? strikes : null;
    });
  });
  return { v: 1, lines };
}

/** Plain text of the document: the last-struck character in each cell. */
function contentToText(content) {
  return content.lines
    .map((line) => line.map((cell) => (cell ? cell[cell.length - 1][0] : ' ')).join('').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\s+$/, '');
}

function derived(content) {
  const text = contentToText(content);
  const words = text.split(/\s+/).filter(Boolean).length;
  return { preview: text.replace(/\s+/g, ' ').trim().slice(0, 220), wordCount: words };
}

const SETTINGS_KEYS = {
  cols: (v) => Number.isInteger(v) && v >= 40 && v <= MAX_COLS,
  paper: (v) => ['ivory', 'white', 'manila', 'onion'].includes(v),
  ink: (v) => v === 0 || v === 1,
  sound: (v) => typeof v === 'boolean',
  volume: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  corrections: (v) => ['none', 'tape', 'free'].includes(v),
  linesPerPage: (v) => Number.isInteger(v) && v >= 20 && v <= 80,
  spacing: (v) => [1, 2].includes(v),
  face: (v) => ['elite', 'prime'].includes(v),
  margin: (v) => ['lock', 'wrap'].includes(v),
  lamp: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
  cursor: (v) => typeof v === 'object' && v !== null && Number.isInteger(v.row) && Number.isInteger(v.col),
};
function sanitizeSettings(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const [k, ok] of Object.entries(SETTINGS_KEYS)) {
    if (s[k] !== undefined && ok(s[k])) out[k] = k === 'cursor' ? { row: s[k].row, col: s[k].col } : s[k];
  }
  return out;
}

function cleanTitle(t) {
  const title = String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return title || 'Untitled';
}

function docOut(d) {
  return {
    id: d.id,
    title: d.title,
    content: d.content,
    settings: d.settings || {},
    wordCount: d.word_count,
    shareToken: d.share_token || null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await store.createSession({ token, userId, expiresAt });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    expires: expiresAt,
    path: '/',
  });
}

const loadUser = asyncH(async (req, res, next) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    const s = await store.getSession(token);
    if (s) req.user = await store.getUserById(s.user_id);
  }
  next();
});

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

app.use('/api', loadUser);

const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post(
  '/api/auth/register',
  authLimiter,
  asyncH(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim().slice(0, 80);
    const password = String(req.body.password || '');
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Please enter a valid email.');
    if (!name) throw httpError(400, 'Please enter your name.');
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
    const passwordHash = await bcrypt.hash(password, 11);
    let user;
    try {
      user = await store.createUser({ email, name, passwordHash });
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'An account with that email already exists.');
      throw e;
    }
    await startSession(res, user.id);
    res.status(201).json({ user });
  })
);

app.post(
  '/api/auth/login',
  authLimiter,
  asyncH(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const u = await store.getUserByEmail(email);
    const ok = u && (await bcrypt.compare(password, u.password_hash));
    if (!ok) throw httpError(401, 'Email or password is incorrect.');
    await startSession(res, u.id);
    res.json({ user: { id: u.id, email: u.email, name: u.name } });
  })
);

app.post(
  '/api/auth/logout',
  asyncH(async (req, res) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await store.deleteSession(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  })
);

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user || null });
});

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */
app.get(
  '/api/docs',
  requireUser,
  asyncH(async (req, res) => {
    const docs = await store.listDocs(req.user.id);
    res.json({
      docs: docs.map((d) => ({
        id: d.id, title: d.title, preview: d.preview, wordCount: d.word_count,
        shared: d.shared, createdAt: d.created_at, updatedAt: d.updated_at,
      })),
    });
  })
);

app.post(
  '/api/docs',
  requireUser,
  asyncH(async (req, res) => {
    const content = sanitizeContent(req.body.content || { lines: [[]] });
    const settings = sanitizeSettings(req.body.settings);
    const d = await store.createDoc({
      userId: req.user.id,
      title: cleanTitle(req.body.title),
      content,
      settings,
      ...derived(content),
    });
    res.status(201).json({ doc: docOut(d) });
  })
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.param('id', (req, res, next, id) => (UUID_RE.test(id) ? next() : res.status(404).json({ error: 'Not found' })));

app.get(
  '/api/docs/:id',
  requireUser,
  asyncH(async (req, res) => {
    const d = await store.getDoc(req.params.id, req.user.id);
    if (!d) throw httpError(404, 'Document not found.');
    res.json({ doc: docOut(d) });
  })
);

app.put(
  '/api/docs/:id',
  requireUser,
  asyncH(async (req, res) => {
    const fields = {};
    if (req.body.title !== undefined) fields.title = cleanTitle(req.body.title);
    if (req.body.settings !== undefined) fields.settings = sanitizeSettings(req.body.settings);
    if (req.body.content !== undefined) {
      fields.content = sanitizeContent(req.body.content);
      Object.assign(fields, derived(fields.content));
    }
    const d = await store.updateDoc(req.params.id, req.user.id, fields);
    if (!d) throw httpError(404, 'Document not found.');
    res.json({ doc: { id: d.id, title: d.title, wordCount: d.word_count, updatedAt: d.updated_at } });
  })
);

app.delete(
  '/api/docs/:id',
  requireUser,
  asyncH(async (req, res) => {
    const ok = await store.deleteDoc(req.params.id, req.user.id);
    if (!ok) throw httpError(404, 'Document not found.');
    res.json({ ok: true });
  })
);

app.post(
  '/api/docs/:id/share',
  requireUser,
  asyncH(async (req, res) => {
    const enable = req.body.enabled !== false;
    const existing = await store.getDoc(req.params.id, req.user.id);
    if (!existing) throw httpError(404, 'Document not found.');
    const token = enable ? existing.share_token || crypto.randomBytes(12).toString('base64url') : null;
    const d = await store.setShareToken(req.params.id, req.user.id, token);
    res.json({ shareToken: d.share_token || null });
  })
);

app.get(
  '/api/shared/:token',
  asyncH(async (req, res) => {
    const token = String(req.params.token);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) throw httpError(404, 'Not found');
    const d = await store.getDocByShareToken(token);
    if (!d) throw httpError(404, 'This document is not shared or no longer exists.');
    res.json({
      doc: { title: d.title, content: d.content, settings: d.settings || {}, author: d.author, updatedAt: d.updated_at },
    });
  })
);

app.get('/healthz', (req, res) => res.json({ ok: true, store: store.kind }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ------------------------------------------------------------------ */
/* Frontend                                                            */
/* ------------------------------------------------------------------ */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: IS_PROD ? '1h' : 0, index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
});

store
  .init()
  .then(() => {
    app.listen(PORT, () => console.log(`Naoko listening on :${PORT} (store: ${store.kind})`));
  })
  .catch((e) => {
    console.error('Failed to initialise storage', e);
    process.exit(1);
  });
