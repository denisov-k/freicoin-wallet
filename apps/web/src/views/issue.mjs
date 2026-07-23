// views/issue.mjs — issue a new on-chain asset, in one of three modes picked by a segmented
// switch: a CURRENCY (fungible amounts with a constant/melting/growing rate, live rate
// preview), TOKENS (a set of unique named items — tickets, memberships, keys — minted onto
// one coin), or a Freiland NAME (a registry slot: the same issuance under the hood — a unique
// land-NFT — plus a melting deposit whose demurrage IS the rent; see land.mjs registerName).
// Reads the live session/relay state from ctx; posts via the relay's issue endpoint.
import { $, q, num } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { armOverlay, closeOverlay } from '@/components/modal.mjs';
import { tr, getLang } from '@/services/i18n.mjs';
import { api, ctx } from '@/state/market-ctx.mjs';
import { mvRefresh } from '@/views/exchange.mjs';

let mode = 'a';   // 'a' = currency (amounts), 't' = tokens (unique items), 'n' = Freiland name

async function issue() {
  try {
    const name = $('#iName').value.trim();
    if (!name) throw new Error(tr('enter a name'));
    // Freiland name: the full claim pipeline (mint land-NFT → deposit → standing offer →
    // register) — the registry machinery lives in land.mjs, this is only its issuance face
    if (mode === 'n') {
      const L = await import('@/services/market/land.mjs');
      if (!L.validLandName(name)) throw new Error(tr('bad name (1–32: a-z 0-9 _ -)'));
      const v = num($('#iVal')?.value ?? '');
      if (!(v >= 100)) throw new Error(tr('minimum value is 100 FRC'));
      const log = t => { const el = $('#iLog'); if (el) el.textContent = t; };
      const btn = $('#issueBtn'); if (btn) btn.disabled = true;
      try {
        await L.registerName({ name, valueFrc: v, progress: p => log(
          p === 'mint' ? tr('minting the name token…')
          : p === 'lock' ? tr('locking the deposit…')
          : p === 'confirm' ? tr('waiting for confirmation (this can take a few minutes)…')
          : p === 'offer' ? tr('signing the standing sale offer…')
          : tr('registered ✅')) });
        $('#modal')?.remove();
        toast(`${name}: ${tr('name claimed ✅')}`, 'ok'); mvRefresh();
      } catch (e) { log(e.message); throw e; }
      finally { const b = $('#issueBtn'); if (b) b.disabled = false; }
      return;
    }
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
    <label>${tr('Name')}<input id="iName" maxlength="24" placeholder="${tr('e.g. labor-hours')}"></label>
    <div class="seg" id="iMode">
      <button data-m="a" class="on">${tr('Currency')}</button>
      <button data-m="t">${tr('Tokens')}</button>
      <button data-m="n">🗺️ ${tr('Name')}</button>
    </div>
    <p class="sub" id="iModeHint" style="font-size:12px">${tr('Fungible units — a local currency, points, labor hours. They divide, add up, and can stay constant, melt or grow at your rate.')}</p>
    <div id="iFungible" class="stack">
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
    <div id="iTokensBox" class="stack" hidden>
      <label>${tr('Unique items (tokens)')}<textarea id="iToks" class="txt-ui" rows="4" placeholder="${tr('one per line')}"></textarea></label>
    </div>
    <div id="iLandBox" class="stack" hidden>
      <div class="sub" id="iAvail" style="font-size:12px"></div>
      <label>${tr('Self-assessed value')} (FRC)<input id="iVal" type="text" inputmode="decimal" placeholder="100+"></label>
      <div class="rrow"><span>${tr('Rent (auto, demurrage)')}</span><b id="iRent" class="sub">—</b></div>
    </div>
    <div id="iLog" class="sub" style="font-size:12px;white-space:pre-line"></div>
    <button id="issueBtn">${tr('Issue asset')}</button></div>`;
  document.body.appendChild(m);
  armOverlay(m);
  q(m, '#issClose').onclick = () => closeOverlay(m);
  q(m, '#issueBtn').onclick = issue;
  // mode switch: one form, three faces
  m.querySelectorAll('#iMode button').forEach((/** @type {HTMLButtonElement} */ b) => b.onclick = () => {
    mode = b.dataset.m;
    m.querySelectorAll('#iMode button').forEach(x => x.classList.toggle('on', x === b));
    $('#iFungible').hidden = mode !== 'a';
    $('#iTokensBox').hidden = mode !== 't';
    $('#iLandBox').hidden = mode !== 'n';
    /** @type {HTMLInputElement} */ ($('#iName')).maxLength = mode === 'n' ? 32 : 24;   // land-имена до 32
    $('#issueBtn').textContent = mode === 'n' ? tr('Claim the name') : tr('Issue asset');
    $('#iModeHint').textContent = mode === 't'
      ? tr('Unique named items — tickets, memberships, keys. They do not melt, travel whole on one coin, and names must not repeat.')
      : mode === 'n'
        ? tr('claim a name — your deposit melts as rent; anyone can buy it at your self-assessed price')
        : tr('Fungible units — a local currency, points, labor hours. They divide, add up, and can stay constant, melt or grow at your rate.');
    if (mode === 'n') $('#iName').dispatchEvent(new Event('input'));   // сразу проверить занятость
  });
  // Freiland-режим: живая проверка доступности имени + годовая рента от заявленной V
  let availT = null;
  q(m, '#iName').addEventListener('input', () => {
    if (mode !== 'n') return;
    const el = $('#iAvail'); if (el) { el.textContent = ''; el.style.color = ''; }
    clearTimeout(availT);
    const name = q(m, '#iName').value.trim();
    if (!name) return;
    availT = setTimeout(async () => {
      const L = await import('@/services/market/land.mjs');
      if (!L.validLandName(name)) { const e2 = $('#iAvail'); if (e2) { e2.textContent = tr('bad name (1–32: a-z 0-9 _ -)'); e2.style.color = 'var(--err)'; } return; }
      const addr = await L.resolveName(name); if (q(m, '#iName').value.trim() !== name) return;
      const e2 = $('#iAvail');
      if (e2) { e2.textContent = addr ? tr('name taken') : tr('available'); e2.style.color = addr ? 'var(--err)' : 'var(--ok)'; }
    }, 400);
  });
  q(m, '#iVal').oninput = async () => {
    const v = num($('#iVal').value) || 0; const el = $('#iRent');
    const L = await import('@/services/market/land.mjs');
    if (el) el.textContent = v > 0 ? `≈ ${(Number(L.annualRent(BigInt(Math.round(v * 1e8)))) / 1e8).toLocaleString(getLang(), { maximumFractionDigits: 2 })} FRC/${tr('yr')}` : '—';
  };
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
