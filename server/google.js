'use strict';
/**
 * Google account connection: OAuth 2.0 (authorization code, offline access),
 * encrypted token storage, access-token refresh and a small API client.
 *
 * Scope is drive.file: Naoko can only see and edit the Google Docs it
 * creates itself, never the rest of the user's Drive.
 *
 * Environment:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   OAuth client (Web application)
 *   GOOGLE_REDIRECT_URI                       optional; defaults to <this host>/api/google/callback
 *   TOKEN_ENC_KEY                             32-byte key (base64/hex) used to encrypt stored tokens
 * Endpoint overrides (tests only): GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL,
 *   GOOGLE_DOCS_BASE, GOOGLE_DRIVE_BASE
 */
const crypto = require('crypto');

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];
const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const REVOKE_URL = process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const DOCS_BASE = process.env.GOOGLE_DOCS_BASE || 'https://docs.googleapis.com/v1';
const DRIVE_BASE = process.env.GOOGLE_DRIVE_BASE || 'https://www.googleapis.com/drive/v3';

const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

/* ------------------------------------------------------------------ */
/* Token encryption (AES-256-GCM)                                      */
/* ------------------------------------------------------------------ */
let keyCache = null;
function encKey() {
  if (keyCache) return keyCache;
  const raw = process.env.TOKEN_ENC_KEY;
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    keyCache = buf.length === 32 ? buf : crypto.createHash('sha256').update(raw).digest();
  } else {
    // Fallback so local development works; production should set TOKEN_ENC_KEY.
    if (process.env.NODE_ENV === 'production') console.warn('[google] TOKEN_ENC_KEY is not set; deriving a key from the client secret.');
    keyCache = crypto.createHash('sha256').update(`naoko-token-key:${process.env.GOOGLE_CLIENT_SECRET || 'dev'}`).digest();
  }
  return keyCache;
}
function seal(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
function open(sealed) {
  if (!sealed) return null;
  const [v, iv, tag, body] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('Unknown token format');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* OAuth                                                               */
/* ------------------------------------------------------------------ */
const pendingStates = new Map(); // state -> { userId, returnTo, exp }
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of pendingStates) if (v.exp < t) pendingStates.delete(k);
}, 60_000).unref();

function redirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/google/callback`;
}

function authUrl(req, userId, returnTo) {
  const state = crypto.randomBytes(24).toString('base64url');
  pendingStates.set(state, { userId, returnTo, exp: Date.now() + 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

function takeState(state) {
  const s = pendingStates.get(state);
  pendingStates.delete(state);
  return s && s.exp > Date.now() ? s : null;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      ...body,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `Token request failed (${res.status})`);
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

/** Exchange an authorization code and store the user's tokens. */
async function connect(store, req, userId, code) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(req) });
  if (!t.refresh_token) throw new Error('Google did not return offline access. Please try connecting again.');
  const granted = String(t.scope || '').split(' ');
  if (t.scope && !granted.includes('https://www.googleapis.com/auth/drive.file')) {
    const err = new Error('Naoko needs permission to create Google Docs. Please allow it on the Google screen.');
    err.code = 'scope_denied';
    throw err;
  }
  await store.saveGoogleAccount(userId, {
    email: emailFromIdToken(t.id_token),
    refreshToken: seal(t.refresh_token),
    accessToken: seal(t.access_token),
    accessExpiresAt: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000),
  });
}

async function disconnect(store, userId) {
  const acct = await store.getGoogleAccount(userId);
  if (acct) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: open(acct.refresh_token) }),
      });
    } catch { /* revoking is best effort */ }
  }
  await store.deleteGoogleAccount(userId);
}

class GoogleAuthError extends Error {}

/** A valid access token for the user, refreshing it when needed. */
async function accessToken(store, userId) {
  const acct = await store.getGoogleAccount(userId);
  if (!acct) throw new GoogleAuthError('Google Drive is not connected.');
  const exp = acct.access_expires_at ? new Date(acct.access_expires_at).getTime() : 0;
  if (acct.access_token && exp - Date.now() > 60_000) return open(acct.access_token);
  let t;
  try {
    t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: open(acct.refresh_token) });
  } catch (e) {
    if (e.code === 'invalid_grant') {
      await store.deleteGoogleAccount(userId);
      throw new GoogleAuthError('Google access was revoked. Reconnect Google Drive to keep syncing.');
    }
    throw e;
  }
  await store.saveGoogleAccount(userId, {
    refreshToken: t.refresh_token ? seal(t.refresh_token) : acct.refresh_token,
    accessToken: seal(t.access_token),
    accessExpiresAt: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000),
  });
  return t.access_token;
}

/* ------------------------------------------------------------------ */
/* API client                                                          */
/* ------------------------------------------------------------------ */
class GoogleApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && (data.error.message || data.error.status)) || `Google API error (${res.status})`;
    throw new GoogleApiError(res.status, msg, data);
  }
  return data;
}

const docs = {
  create: (token, title) => api(token, 'POST', `${DOCS_BASE}/documents`, { title }),
  get: (token, id, fields) =>
    api(token, 'GET', `${DOCS_BASE}/documents/${encodeURIComponent(id)}${fields ? `?fields=${encodeURIComponent(fields)}` : ''}`),
  batchUpdate: (token, id, requests, writeControl) =>
    api(token, 'POST', `${DOCS_BASE}/documents/${encodeURIComponent(id)}:batchUpdate`, writeControl ? { requests, writeControl } : { requests }),
};
const drive = {
  rename: (token, id, name) => api(token, 'PATCH', `${DRIVE_BASE}/files/${encodeURIComponent(id)}?fields=id,name`, { name }),
};

module.exports = {
  configured,
  authUrl,
  takeState,
  connect,
  disconnect,
  accessToken,
  redirectUri,
  docs,
  drive,
  GoogleApiError,
  GoogleAuthError,
  _crypto: { seal, open },
};
