const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export const api = {
  search: (q) => request(`/api/products/search?q=${encodeURIComponent(q)}`),
  track: (payload) =>
    request('/api/products/track', { method: 'POST', body: JSON.stringify(payload) }),
  list: () => request('/api/products'),
  history: (id) => request(`/api/products/${id}/history`),
  exportCsvUrl: () => `${BASE}/api/export/csv`,
};
