// mapsearch.mjs — finding the ground you mean by typing its name, for any map in the wallet.
//
// The lookup goes to OpenStreetMap's geocoder — the same trade the basemap already makes: it learns
// what you searched for, and nothing else about the wallet goes near it. Only on Enter or after a
// pause, never per keystroke, as their usage policy asks.
import { tr, getLang } from '@/services/i18n.mjs';

const URL = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5';

/** Mount a place search into `el` (which gets the .map-search markup).
 *  @param {{el:HTMLElement, onPick:(p:{lat:number,lon:number})=>void}} o */
export function mountMapSearch({ el, onPick }) {
  el.classList.add('map-search');
  el.innerHTML = `<input type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="${tr('Find a place')}">
    <div class="map-search-res" hidden></div>`;
  const inp = /** @type {HTMLInputElement} */ (el.querySelector('input'));
  const res = /** @type {HTMLElement} */ (el.querySelector('.map-search-res'));
  const show = html => { res.innerHTML = html; res.hidden = !html; };
  let timer = null;

  async function find() {
    const term = inp.value.trim();
    if (term.length < 3) return show('');
    show(`<div class="sub" style="padding:8px 10px">${tr('searching…')}</div>`);
    try {
      const found = await (await fetch(`${URL}&accept-language=${encodeURIComponent(getLang())}&q=${encodeURIComponent(term)}`)).json();
      if (inp.value.trim() !== term) return;                        // a newer search won
      if (!found.length) return show(`<div class="sub" style="padding:8px 10px">${tr('nothing found')}</div>`);
      show(found.map((f, i) => `<button class="mapfind" data-i="${i}">${f.display_name}</button>`).join(''));
      res.querySelectorAll('.mapfind').forEach((/** @type {HTMLButtonElement} */ b) => b.onclick = () => {
        const f = found[+b.dataset.i];
        onPick({ lat: +f.lat, lon: +f.lon });
        show(''); inp.blur();
      });
    } catch { show(`<div class="sub" style="padding:8px 10px">${tr('search is unavailable')}</div>`); }
  }

  inp.oninput = () => { clearTimeout(timer); timer = setTimeout(find, 800); };
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); find(); } };
  return { clear: () => { inp.value = ''; show(''); } };
}
