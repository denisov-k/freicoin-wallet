// modal.mjs — a .review card in the #modal overlay, tap-outside or ✕ to close.
// `title` gets a header row with a close button; returns the overlay so callers can wire the body
// and later remove it.
export const openModal = (title, inner) => {
  document.querySelector('#modal')?.remove();
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${title}</b><button id="mClose" class="icon">✕</button></div>
    ${inner}</div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };
  // @ts-ignore — false positive (DOM/Promise<void> under checkJs)
  m.querySelector('#mClose').onclick = () => m.remove();
  return m;
};
