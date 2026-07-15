// toast.mjs — the single transient status toast (targets the shared #toast element).
let toastTimer = null;
/** show a toast; `type` is a CSS class ('ok' | 'err' | …). Empty message clears it. */
export const toast = (msg, type = 'ok') => {
  const el = document.querySelector('#toast'); if (!el) return;
  clearTimeout(toastTimer);
  if (!msg) { el.className = ''; el.textContent = ''; return; }
  el.textContent = msg; el.className = 'show ' + type;
  toastTimer = setTimeout(() => el.className = '', 2800);
};
