// dom.mjs — DOM lookups, localStorage, number/hex formatting and small render primitives.
// Pure and app-state-free: safe to import from any view or component.
import { tr, getLang } from '@/services/i18n.mjs';

/** @type {(s: string) => any} */   // any: elements are used dynamically (.onclick/.value)
export const $ = s => document.querySelector(s);
/** @type {(el: any, s: string) => any} */
export const q = (el, s) => el.querySelector(s);

export const store = { get: k => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v), del: k => localStorage.removeItem(k) };

export const short = a => a && a.length > 20 ? a.slice(0, 12) + '…' + a.slice(-8) : (a || '');
export const fmt = n => (+n).toLocaleString(undefined, { maximumFractionDigits: 8 });
// Display balance: 2 decimals, rounded DOWN (never show more than is spendable) — the demurrage
// churns the low digits every block, so full precision is visual noise here. Full 8-digit precision
// stays where it matters: amounts, fees, activity records.
export const fmtBal = n => (Math.floor((+n) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const frc = v => (Number(BigInt(v)) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 8 });
export const num = v => parseFloat(String(v ?? '').replace(',', '.'));   // locale-tolerant: accepts a comma decimal
export const rev = h => h.match(/../g).reverse().join('');

export const copy = (t, el) => { navigator.clipboard?.writeText(t); if (el) { const o = el.textContent; el.textContent = tr('copied ✓'); setTimeout(() => el.textContent = o, 1200); } };

export const skel = (n = 1) => Array.from({ length: n }, () => '<div class="skel"></div>').join('');
export const skelRows = n => Array.from({ length: n }, () =>
  '<tr><td><div class="skel-line" style="height:16px;width:70%;margin:4px 0"></div></td><td><div class="skel-line" style="height:16px;width:45%;margin:4px 0 4px auto"></div></td></tr>').join('');

// value-preserving <select> repaint: keep the current selection across an innerHTML swap.
export function setOptions(sel, html) {
  const el = $(sel); if (!el) return;
  const cur = el.value; el.innerHTML = html;
  if ([...el.options].some(o => o.value === cur)) el.value = cur;
}
