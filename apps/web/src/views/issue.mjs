// views/issue.mjs — issue a new on-chain asset, in one of two modes picked by a segmented
// switch: a CURRENCY (fungible amounts with a constant/melting/growing rate, live rate
// preview) or TOKENS (a set of unique named items — tickets, memberships, keys — minted onto
// one coin). Reads the live session/relay state from ctx; posts via the relay's issue endpoint.
import { $, q } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { tr, getLang } from '@/services/i18n.mjs';
import { api, ctx } from '@/state/market-ctx.mjs';
import { mvRefresh } from '@/views/exchange.mjs';

let mode = 'a';   // 'a' = currency (amounts), 't' = tokens (unique items)

async function issue() {
  try {
    const name = $('#iName').value.trim() || 'актив';
    if (mode === 't') {
      const tokens = ($('#iToks')?.value ?? '').split('\n').map(s => s.trim()).filter(Boolean);
      if (!tokens.length) throw new Error(tr('add at least one item'));
      if (tokens.length !== new Set(tokens).size) throw new Error(tr('token names must be unique'));
      // tokens ride one coin; the fungible side is a flat 1 unit per item (shift-64 interest
      // floors growth to exactly zero — truly constant, nothing to melt)
      await api('issue', { name, shift: 64, interest: true, amount: tokens.length, decimals: 0, spk: ctx.spks[0], tokens });
    } else {
      // 'constant' = shift-64 INTEREST: growth of 2^-64/block floors to exactly zero at any age
      // and any amount — truly flat. (The demurrage side would round ONE base unit off, which on
      // a whole-unit asset is a visible token.)
      const kind = $('#iKind').value;
      await api('issue', { name, shift: kind === 'c' ? 64 : Math.min(63, Math.max(1, Math.round(+$('#iShift').value || 16))), interest: kind === 'i' || kind === 'c', amount: $('#iAmt').value, decimals: $('#iDec')?.value ?? 0, spk: ctx.spks[0] });
    }
    $('#modal')?.remove();
    toast(`«${name}» ${tr('issued to your address')}`, 'ok'); mvRefresh();
  } catch (e) { toast(e.message, 'err'); }
}

export function openIssueModal() {
  if ($('#modal')) return;
  mode = 'a';
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${tr('Issue asset')}</b><button id="issClose" class="icon">✕</button></div>
    <div class="seg" id="iMode">
      <button data-m="a" class="on">${tr('Currency (amounts)')}</button>
      <button data-m="t">${tr('Tokens (unique items)')}</button>
    </div>
    <p class="sub" id="iModeHint">${tr('Issue an asset that lives on the chain: constant, melting (demurrage) or growing (interest).')}</p>
    <label>${tr('Name')}<input id="iName" maxlength="24" placeholder="часы-труда"></label>
    <div id="iFungible">
      <div class="row">
        <label>${tr('Type')}<select id="iKind"><option value="c">${tr('constant')}</option><option value="d">${tr('melts')}</option><option value="i">${tr('grows')}</option></select></label>
        <label id="iRateLbl" hidden>${tr('Rate k')}<input id="iShift" type="number" value="16" min="1" max="63" step="1"></label>
      </div>
      <p class="sub" id="iRateHint" style="font-size:12px" hidden></p>
      <div class="row">
        <label>${tr('Quantity')}<input id="iAmt" type="number" value="1000000"></label>
        <label>${tr('Decimals')}<select id="iDec"><option value="2">0,01</option><option value="3">0,001</option><option value="0">${tr('whole only')}</option></select></label>
      </div>
      <p class="sub" id="iMeltHint" style="font-size:12px" hidden>${tr('Melting eats whole units on indivisible assets — decimals let it shave fractions instead.')}</p>
    </div>
    <div id="iTokensBox" hidden>
      <label>${tr('Unique items (tokens)')}<textarea id="iToks" rows="4" placeholder="${tr('one per line — tickets, memberships, keys')}"></textarea></label>
      <p class="sub" style="font-size:12px">${tr('Tokens are minted onto one coin with the asset and travel whole; each name must be unique.')}</p>
    </div>
    <button id="issueBtn">${tr('Issue asset')}</button></div>`;
  document.body.appendChild(m);
  m.onclick = e => { if (e.target === m) m.remove(); };
  q(m, '#issClose').onclick = () => m.remove();
  q(m, '#issueBtn').onclick = issue;
  // mode switch: one form, two faces
  m.querySelectorAll('#iMode button').forEach((/** @type {HTMLButtonElement} */ b) => b.onclick = () => {
    mode = b.dataset.m;
    m.querySelectorAll('#iMode button').forEach(x => x.classList.toggle('on', x === b));
    $('#iFungible').hidden = mode === 't';
    $('#iTokensBox').hidden = mode !== 't';
    $('#iModeHint').textContent = mode === 't'
      ? tr('A set of unique named items — they do not melt and are sent whole, one coin per set.')
      : tr('Issue an asset that lives on the chain: constant, melting (demurrage) or growing (interest).');
  });
  const rateHint = () => {
    const kind = $('#iKind').value, el = $('#iRateHint');
    el.hidden = kind === 'c';
    if (el.hidden) return;
    const k = Math.min(63, Math.max(1, Math.round(+$('#iShift').value || 16)));
    const perBlock = 2 ** -k;
    const blocksDay = 86400 / ((ctx.state?.info?.mineEveryMs ?? 20000) / 1000);
    const over = days => kind === 'd' ? 1 - (1 - perBlock) ** (blocksDay * days) : (1 + perBlock) ** (blocksDay * days) - 1;
    // extreme k values compound into astronomy — anything past 9 999% reads as "practically infinite"
    const f = x => { const pc = x * 100; return (!isFinite(pc) || pc > 9999) ? '∞' : pc.toLocaleString(getLang(), { maximumSignificantDigits: 3 }); };
    el.textContent = `≈ ${f(over(1))}% ${tr('per day')} · ≈ ${f(over(30))}% ${tr('per month')} · ≈ ${f(over(365))}% ${tr('per year')}`;
  };
  q(m, '#iShift').oninput = e => {   // hard-clamp typed values (min/max only guard the spinner)
    const v = e.target.value;
    if (v !== '') { const c = Math.min(63, Math.max(1, Math.round(+v || 1))); if (String(c) !== v) e.target.value = c; }
    rateHint();
  };
  q(m, '#iKind').onchange = e => {
    $('#iRateLbl').hidden = e.target.value === 'c';        // constant has no rate at all
    // rounding hint per type: melting EATS whole units; growth STALLS below a whole unit
    const hint = $('#iMeltHint');
    hint.hidden = e.target.value === 'c';
    if (!hint.hidden) hint.textContent = e.target.value === 'd'
      ? tr('Melting eats whole units on indivisible assets — decimals let it shave fractions instead.')
      : tr('Growth rounds down — small indivisible holdings stall until a whole unit accrues; decimals make it smooth.');
    rateHint();
  };
}
