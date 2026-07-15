// modal.mjs — a .review card in the #modal overlay, tap-outside or ✕ to close.
// `title` gets a header row with a close button; returns the overlay so callers can wire the body
// and later remove it.

// Closing a modal must SWALLOW the tap that closed it: once the overlay is gone, iOS re-targets
// the synthesized click at whatever sits under the finger — a button on the page "presses
// itself". The shield eats capture-phase clicks for a beat after every close.
const shield = () => {
  const block = ev => { ev.stopPropagation(); ev.preventDefault(); };
  document.addEventListener('click', block, true);
  setTimeout(() => document.removeEventListener('click', block, true), 400);
};
export function closeOverlay(m) { shield(); m.remove(); }

/** Wire tap-outside-to-close on an overlay: only when the press both STARTED and ended on the
 *  backdrop (a drag from inside the card that ends outside must not dismiss), with the ghost-tap
 *  shield on close. */
export function armOverlay(m) {
  let down = false;
  m.addEventListener('pointerdown', e => { down = e.target === m; });
  m.addEventListener('click', e => { if (e.target === m && down) closeOverlay(m); down = false; });
}

export const openModal = (title, inner) => {
  document.querySelector('#modal')?.remove();
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${title}</b><button id="mClose" class="icon">✕</button></div>
    ${inner}</div>`;
  document.body.appendChild(m);
  armOverlay(m);
  // @ts-ignore — false positive (DOM/Promise<void> under checkJs)
  m.querySelector('#mClose').onclick = () => closeOverlay(m);
  return m;
};
