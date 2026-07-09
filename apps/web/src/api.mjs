// api.mjs — client for the variant-C backend.
// Backend URL: user setting > build-time VITE_BACKEND > localhost.
const DEFAULT = import.meta.env?.VITE_BACKEND || 'http://127.0.0.1:3030';
const base = () => localStorage.getItem('fw_backend') || DEFAULT;
const get = async p => { const r = await fetch(base() + p); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); };
export const health = () => get('/health');
export const address = (index = 0, chain = 0) => get(`/address?index=${index}&chain=${chain}`);
export const balance = () => get('/balance');
export const utxos = () => get('/utxos');
export const broadcast = async rawtx => {
  const r = await fetch(base() + '/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawtx }) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
};
