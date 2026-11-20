'use strict';
/**
 * Storage layer. Uses PostgreSQL when DATABASE_URL is set (Render),
 * otherwise falls back to a JSON file on disk for local development.
 * Both backends expose the same async interface.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/* ------------------------------------------------------------------ */
/* PostgreSQL                                                          */
/* ------------------------------------------------------------------ */
function createPgStore(connectionString) {
  const { Pool } = require('pg');
  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: isLocal || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 10,
  });

  const q = (text, params) => pool.query(text, params);

  return {
    kind: 'postgres',
    async init() {
      await q(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS documents (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          content JSONB NOT NULL,
          settings JSONB NOT NULL DEFAULT '{}'::jsonb,
          preview TEXT NOT NULL DEFAULT '',
          word_count INTEGER NOT NULL DEFAULT 0,
          share_token TEXT UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS documents_user_idx ON documents(user_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS google_accounts (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          email TEXT,
          refresh_token TEXT NOT NULL,
          access_token TEXT,
          access_expires_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS gdoc_id TEXT;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS gdoc_sync BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS gdoc_state JSONB;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS gdoc_synced_at TIMESTAMPTZ;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS gdoc_error TEXT;
      `);
      await q('DELETE FROM sessions WHERE expires_at < now()');
    },
    async createUser({ email, name, passwordHash }) {
      const id = uuid();
      const { rows } = await q(
        'INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, name, created_at',
        [id, email, name, passwordHash]
      );
      return rows[0];
    },
    async getUserByEmail(email) {
      const { rows } = await q('SELECT * FROM users WHERE email = $1', [email]);
      return rows[0] || null;
    },
    async getUserById(id) {
      const { rows } = await q('SELECT id, email, name, created_at FROM users WHERE id = $1', [id]);
      return rows[0] || null;
    },
    async createSession({ token, userId, expiresAt }) {
      await q('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)', [token, userId, expiresAt]);
    },
    async getSession(token) {
      const { rows } = await q('SELECT * FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
      return rows[0] || null;
    },
    async deleteSession(token) {
      await q('DELETE FROM sessions WHERE token = $1', [token]);
    },
    async listDocs(userId) {
      const { rows } = await q(
        `SELECT id, title, preview, word_count, share_token IS NOT NULL AS shared, gdoc_sync, created_at, updated_at
         FROM documents WHERE user_id = $1 ORDER BY updated_at DESC`,
        [userId]
      );
      return rows;
    },
    async createDoc({ userId, title, content, settings, preview, wordCount }) {
      const id = uuid();
      const { rows } = await q(
        `INSERT INTO documents (id, user_id, title, content, settings, preview, word_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, userId, title, JSON.stringify(content), JSON.stringify(settings), preview, wordCount]
      );
      return rows[0];
    },
    async getDoc(id, userId) {
      const { rows } = await q('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [id, userId]);
      return rows[0] || null;
    },
    async updateDoc(id, userId, fields) {
      const sets = [];
      const params = [];
      const map = { title: 'title', content: 'content', settings: 'settings', preview: 'preview', wordCount: 'word_count' };
      for (const [k, col] of Object.entries(map)) {
        if (fields[k] === undefined) continue;
        const v = k === 'content' || k === 'settings' ? JSON.stringify(fields[k]) : fields[k];
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
      sets.push('updated_at = now()');
      params.push(id, userId);
      const { rows } = await q(
        `UPDATE documents SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
        params
      );
      return rows[0] || null;
    },
    async deleteDoc(id, userId) {
      const { rowCount } = await q('DELETE FROM documents WHERE id = $1 AND user_id = $2', [id, userId]);
      return rowCount > 0;
    },
    async setShareToken(id, userId, token) {
      const { rows } = await q(
        'UPDATE documents SET share_token = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
        [token, id, userId]
      );
      return rows[0] || null;
    },
    async getGoogleAccount(userId) {
      const { rows } = await q('SELECT * FROM google_accounts WHERE user_id = $1', [userId]);
      return rows[0] || null;
    },
    async saveGoogleAccount(userId, f) {
      await q(
        `INSERT INTO google_accounts (user_id, email, refresh_token, access_token, access_expires_at, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (user_id) DO UPDATE SET
           email = COALESCE(EXCLUDED.email, google_accounts.email),
           refresh_token = EXCLUDED.refresh_token,
           access_token = EXCLUDED.access_token,
           access_expires_at = EXCLUDED.access_expires_at,
           updated_at = now()`,
        [userId, f.email || null, f.refreshToken, f.accessToken || null, f.accessExpiresAt || null]
      );
    },
    async deleteGoogleAccount(userId) {
      await q('DELETE FROM google_accounts WHERE user_id = $1', [userId]);
      await q('UPDATE documents SET gdoc_sync = false WHERE user_id = $1', [userId]);
    },
    /** Google mirror bookkeeping; deliberately does not touch updated_at. */
    async updateDocGoogle(id, userId, f) {
      const map = { gdocId: 'gdoc_id', gdocSync: 'gdoc_sync', gdocState: 'gdoc_state', gdocSyncedAt: 'gdoc_synced_at', gdocError: 'gdoc_error' };
      const sets = [];
      const params = [];
      for (const [k, col] of Object.entries(map)) {
        if (f[k] === undefined) continue;
        params.push(k === 'gdocState' && f[k] !== null ? JSON.stringify(f[k]) : f[k]);
        sets.push(`${col} = $${params.length}`);
      }
      if (!sets.length) return null;
      params.push(id, userId);
      const { rows } = await q(
        `UPDATE documents SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
        params
      );
      return rows[0] || null;
    },
    async getDocByShareToken(token) {
      const { rows } = await q(
        `SELECT d.*, u.name AS author FROM documents d JOIN users u ON u.id = d.user_id WHERE d.share_token = $1`,
        [token]
      );
      return rows[0] || null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* JSON file (local development)                                       */
/* ------------------------------------------------------------------ */
function createFileStore(file) {
  let data = { users: [], sessions: [], documents: [], google: [] };
  let writeTimer = null;

  const persist = () => {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    }, 100);
  };
  const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, created_at: u.created_at };
  const summary = (d) => ({
    id: d.id, title: d.title, preview: d.preview, word_count: d.word_count,
    shared: !!d.share_token, gdoc_sync: !!d.gdoc_sync, created_at: d.created_at, updated_at: d.updated_at,
  });

  return {
    kind: 'file',
    async init() {
      if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.google = data.google || [];
      const t = Date.now();
      data.sessions = data.sessions.filter((s) => new Date(s.expires_at).getTime() > t);
    },
    async createUser({ email, name, passwordHash }) {
      if (data.users.some((u) => u.email === email)) {
        const err = new Error('duplicate'); err.code = '23505'; throw err;
      }
      const u = { id: uuid(), email, name, password_hash: passwordHash, created_at: now() };
      data.users.push(u); persist();
      return publicUser(u);
    },
    async getUserByEmail(email) { return data.users.find((u) => u.email === email) || null; },
    async getUserById(id) { return publicUser(data.users.find((u) => u.id === id)) || null; },
    async createSession({ token, userId, expiresAt }) {
      data.sessions.push({ token, user_id: userId, expires_at: new Date(expiresAt).toISOString() }); persist();
    },
    async getSession(token) {
      const s = data.sessions.find((x) => x.token === token);
      return s && new Date(s.expires_at).getTime() > Date.now() ? s : null;
    },
    async deleteSession(token) { data.sessions = data.sessions.filter((s) => s.token !== token); persist(); },
    async listDocs(userId) {
      return data.documents.filter((d) => d.user_id === userId)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(summary);
    },
    async createDoc({ userId, title, content, settings, preview, wordCount }) {
      const d = {
        id: uuid(), user_id: userId, title, content, settings, preview, word_count: wordCount,
        share_token: null, created_at: now(), updated_at: now(),
      };
      data.documents.push(d); persist();
      return d;
    },
    async getDoc(id, userId) { return data.documents.find((d) => d.id === id && d.user_id === userId) || null; },
    async updateDoc(id, userId, fields) {
      const d = data.documents.find((x) => x.id === id && x.user_id === userId);
      if (!d) return null;
      if (fields.title !== undefined) d.title = fields.title;
      if (fields.content !== undefined) d.content = fields.content;
      if (fields.settings !== undefined) d.settings = fields.settings;
      if (fields.preview !== undefined) d.preview = fields.preview;
      if (fields.wordCount !== undefined) d.word_count = fields.wordCount;
      d.updated_at = now(); persist();
      return d;
    },
    async deleteDoc(id, userId) {
      const before = data.documents.length;
      data.documents = data.documents.filter((d) => !(d.id === id && d.user_id === userId));
      persist();
      return data.documents.length < before;
    },
    async setShareToken(id, userId, token) {
      const d = data.documents.find((x) => x.id === id && x.user_id === userId);
      if (!d) return null;
      d.share_token = token; persist();
      return d;
    },
    async getGoogleAccount(userId) { return data.google.find((g) => g.user_id === userId) || null; },
    async saveGoogleAccount(userId, f) {
      let g = data.google.find((x) => x.user_id === userId);
      if (!g) { g = { user_id: userId }; data.google.push(g); }
      if (f.email) g.email = f.email;
      g.refresh_token = f.refreshToken;
      g.access_token = f.accessToken || null;
      g.access_expires_at = f.accessExpiresAt ? new Date(f.accessExpiresAt).toISOString() : null;
      g.updated_at = now();
      persist();
    },
    async deleteGoogleAccount(userId) {
      data.google = data.google.filter((g) => g.user_id !== userId);
      data.documents.forEach((d) => { if (d.user_id === userId) d.gdoc_sync = false; });
      persist();
    },
    async updateDocGoogle(id, userId, f) {
      const d = data.documents.find((x) => x.id === id && x.user_id === userId);
      if (!d) return null;
      if (f.gdocId !== undefined) d.gdoc_id = f.gdocId;
      if (f.gdocSync !== undefined) d.gdoc_sync = f.gdocSync;
      if (f.gdocState !== undefined) d.gdoc_state = f.gdocState;
      if (f.gdocSyncedAt !== undefined) d.gdoc_synced_at = f.gdocSyncedAt ? new Date(f.gdocSyncedAt).toISOString() : null;
      if (f.gdocError !== undefined) d.gdoc_error = f.gdocError;
      persist();
      return d;
    },
    async getDocByShareToken(token) {
      const d = data.documents.find((x) => x.share_token && x.share_token === token);
      if (!d) return null;
      const u = data.users.find((x) => x.id === d.user_id);
      return { ...d, author: u ? u.name : 'Unknown' };
    },
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return createPgStore(process.env.DATABASE_URL);
  const file = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'naoko.json');
  return createFileStore(file);
}

module.exports = { createStore };
