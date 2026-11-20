// Thin JSON client for the Naoko API.
async function request(method, url, body, opts = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    keepalive: !!opts.keepalive,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request('GET', '/api/auth/me'),
  login: (email, password) => request('POST', '/api/auth/login', { email, password }),
  register: (name, email, password) => request('POST', '/api/auth/register', { name, email, password }),
  logout: () => request('POST', '/api/auth/logout'),
  listDocs: () => request('GET', '/api/docs'),
  createDoc: (payload) => request('POST', '/api/docs', payload),
  getDoc: (id) => request('GET', `/api/docs/${id}`),
  saveDoc: (id, payload, opts) => request('PUT', `/api/docs/${id}`, payload, opts),
  deleteDoc: (id) => request('DELETE', `/api/docs/${id}`),
  share: (id, enabled) => request('POST', `/api/docs/${id}/share`, { enabled }),
  shared: (token) => request('GET', `/api/shared/${encodeURIComponent(token)}`),
};
