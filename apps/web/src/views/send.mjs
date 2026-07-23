// views/send.mjs — money movement: the Receive modal (QR + address) and the Send modal with its
// review/broadcast flow (FRC, user assets, and non-custodial BTC). The data-plane it reads and
// mutates (pending tx, verified cache, receive index, light-source lifecycle) lives in the app
// shell and is injected via initSend — the view never reassigns shell state directly.
import { $, copy, short, fmt, frc } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { openModal, closeOverlay } from '@/components/modal.mjs';
import { btcToStr } from '@/services/market/btc-account.mjs';
import { tr, getLang } from '@/services/i18n.mjs';
import QRCode from 'qrcode';
import { deriveAddress, isValidAddress, addrToSpk, buildSignedTx } from '@/services/wallet.mjs';
import { mvBtc, mvBtcAddress, mvBtcValidAddr, mvSendBtc, mvBtcSendFee, mvBtcMax, mvOwnedAssets, mvSendAsset, mvTokenCoins, mvSendTokenCoin, tokLabel } from '@/views/exchange.mjs';

/** deps injected by the app shell (see main.mjs initSend) */
let d;
export const initSend = deps => { d = deps; };

// The FRC "available" is the SPENDABLE balance (matured coins), not the raw balance — freshly-mined
// coinbase shows in the balance but can't be sent for 100 blocks, so offering it here would mislead.
export const availFrc = st => st ? (st.spendable ?? st.balance) : 0;
export function paintSendAvail(st, approx) {
  const el = $('#avail');
  if (el && st) el.textContent = `${tr('available ')}${approx ? '≈ ' : ''}${fmt(availFrc(st))} FRC`;   // full precision — meant to be spent
}

export function renderReceive() {
  // Open in a loading state (shimmering QR + address placeholders), then fill in.
  // Селектор валюты гейтится по СЕТИ (не по mvBtc().available: при первом открытии стейт свопа
  // ещё не доехал, и селектор молча пропадал).
  const btcOn = d.SWAP();
  const lnOn = d.curNet() === 'main';   // ⚡-приём: узел в кошельке (mainnet)
  openModal(tr('Receiving'),
    (btcOn ? `<label>${tr('Currency')}<select id="rcvCur"><option value="FRC">FRC</option><option value="BTC">BTC</option></select></label>` : '')
    // ⚡ — не валюта, а СПОСОБ получения: отдельный переключатель (вкл → сумма-инвойс вместо адреса)
    + (lnOn ? `<label class="chk"><input type="checkbox" id="lnRcvChk">⚡ Lightning</label>` : '')
    + `<div id="lnAmtRow" hidden><label class="numfield">${tr('Amount')} (${tr('sats')})<input id="lnRcvAmt" type="text" inputmode="numeric"></label>
       <div class="row"><button id="lnRcvGo">${tr('Create invoice')}</button></div></div>
     <div id="qrBox" class="qr skel" style="margin:0 auto;height:220px"></div>
     <div class="addr" id="addr"><div class="skel-line" style="height:14px;width:85%;margin:3px auto"></div></div>
     <div class="row"><button id="copyAddr" class="ghost" disabled>⧉ ${tr('Copy')}</button></div>
     <div class="row" id="newAddrRow"><button id="newAddr" class="ghost">${tr('New address')}</button></div>`);
  // ⚡: сумма → инвойс встроенного узла → QR в тот же qrBox, копирование той же кнопкой
  const fillLn = () => {
    $('#lnAmtRow').hidden = false; $('#newAddrRow').hidden = true;
    const cs = $('#rcvCur'); if (cs) cs.disabled = true;   // инвойс — это сатоши; валюта не участвует
    const box = $('#qrBox'); box.className = 'qr'; box.innerHTML = '';
    $('#addr').textContent = tr('enter the amount and create an invoice');
    $('#copyAddr').disabled = true;
    $('#lnRcvGo').onclick = async e => {
      e.target.disabled = true;
      try {
        const sats = Math.round(Number($('#lnRcvAmt').value)); if (!(sats > 0)) throw new Error(tr('bad amount'));
        const bolt11 = await (await import('@/views/lightning.mjs')).lnMakeInvoice(sats);
        const qr = await QRCode.toDataURL(bolt11.toUpperCase(), { margin: 1, width: 220 });
        const b = $('#qrBox'); if (b) { b.className = 'qr'; b.innerHTML = `<img src="${qr}" alt="qr" style="width:100%;height:100%">`; }
        const a = $('#addr'); if (a) a.textContent = bolt11;
        const cp = $('#copyAddr'); if (cp) { cp.disabled = false; cp.onclick = ev => copy(bolt11, ev.target); }
      } catch (err) { toast(err.message, 'err'); }
      e.target.disabled = false;
    };
  };
  // FRC = a fresh HD address; BTC = the single (fixed) account address, so "New address" hides for BTC.
  const fill = async isBtc => {
    $('#lnAmtRow').hidden = true;
    const cs = $('#rcvCur'); if (cs) cs.disabled = false;
    const box0 = $('#qrBox'); if (box0) { box0.className = 'qr skel'; box0.innerHTML = ''; }
    const a0 = $('#addr'); if (a0) a0.innerHTML = `<div class="skel-line" style="height:14px;width:85%;margin:3px auto"></div>`;
    const cp0 = $('#copyAddr'); if (cp0) cp0.disabled = true;
    const nr = $('#newAddrRow'); if (nr) nr.hidden = isBtc;
    const t0 = performance.now();
    let addr; try { addr = isBtc ? mvBtcAddress() : deriveAddress(d.hexSeed(), d.recvIndex(), 0); } catch (e) { return toast(e.message, 'err'); }
    const qr = await QRCode.toDataURL(addr.toUpperCase(), { margin: 1, width: 220 });
    await new Promise(r => setTimeout(r, Math.max(0, 350 - (performance.now() - t0))));
    const box = $('#qrBox'); if (!box) return;   // modal was closed mid-load
    box.className = 'qr'; box.innerHTML = `<img src="${qr}" alt="qr" style="width:100%;height:100%">`;
    $('#addr').textContent = addr;
    const cp = $('#copyAddr'); if (cp) { cp.disabled = false; cp.onclick = e => copy(addr, e.target); }
  };
  const cur = $('#rcvCur'); if (cur) cur.onchange = () => fill(cur.value === 'BTC');
  const lnChk = $('#lnRcvChk'); if (lnChk) lnChk.onchange = () => lnChk.checked ? fillLn() : fill($('#rcvCur')?.value === 'BTC');
  // Fresh FRC address: bump the index + repaint at once, then grow the watch window off-frame.
  $('#newAddr').onclick = () => { d.bumpRecv(); fill(false); d.growWatchAfterNewAddr(); };
  fill(false);
}

export async function renderSend() {
  d.setPending(null);
  // Currency picker shows whenever there's more than FRC to send: assets (nv3 only) and/or BTC
  // (any swap-enabled net, incl. mainnet). Without this, a BTC-holding mainnet wallet could
  // receive BTC but had no way to send it.
  const btcOn = d.SWAP() && mvBtc().available;
  const showCur = d.MKT() || btcOn;
  openModal(tr('Send'),
    `<div id="sendForm" class="stack">
     <div class="sub" id="avail">${tr('available…')}</div>
     ${showCur ? `<label>${d.MKT() ? tr('Asset') : tr('Currency')}<select id="sendAsset"><option value="">FRC</option></select></label>` : ''}
     <label>${tr('To address')}<input id="to" placeholder="fc1…" autocomplete="off"></label>
     <label id="amtLabel">${tr('Amount (FRC)')}<div class="amtrow"><input id="amt" type="number" step="0.00000001" min="0" placeholder="0.0"><button id="maxBtn" class="ghost">${tr('Max')}</button></div></label>
     <div class="stack" id="btcSpeedRow" hidden>
       <label>${tr('Speed')}<select id="btcSpeed"><option value="eco">${tr('Economy (cheaper)')}</option><option value="fast">${tr('Fast (next block)')}</option></select></label>
       <div class="rrow"><span class="sub">${tr('Fee')}</span><b id="btcFee" class="sub">—</b></div>
     </div>
     <div class="stack" id="sendTokPick" hidden></div>
     <button id="reviewBtn">${tr('Review')}</button></div><div id="sendResult" class="stack"></div>`);
  // the Review button doubles as the insufficient-funds indicator: on a BTC shortfall it disables
  // and shows "not enough BTC"; anything else restores it to the normal "Review" label.
  const setReview = (enabled, label) => { const b = $('#reviewBtn'); if (!b) return; b.disabled = !enabled; b.textContent = label || tr('Review'); };
  // live BTC fee for the form (recomputed on amount/speed change) — see btcFast()/updBtcFee below
  const btcFast = () => $('#btcSpeed')?.value === 'fast';
  const updBtcFee = async () => {
    const el = $('#btcFee'); if (!el) return;
    const a = parseFloat($('#amt')?.value); if (!(a > 0)) { el.textContent = '—'; setReview(true); return; }
    el.textContent = '…'; const { fee, enough } = await mvBtcSendFee(a, btcFast()); if (!$('#btcFee')) return;
    el.textContent = fee > 0n ? `${(Number(fee) / 1e8).toFixed(8)} BTC` : '—';   // show the fee even on shortfall
    setReview(enough, enough ? undefined : tr('not enough BTC'));                // shortfall → disabled button
  };
  // FRC: disable the button (with a reason) when the amount exceeds the SPENDABLE balance — the
  // node would reject it anyway (e.g. all coins are immature mined coinbase → spendable 0).
  const updFrcCheck = () => {
    if ($('#sendAsset')?.value) return;   // only the plain-FRC path; BTC/asset have their own checks
    const a = parseFloat($('#amt')?.value);
    if (a > 0 && sendBal != null && a > sendBal) setReview(false, tr('not enough FRC'));
    else setReview(true);
  };
  $('#reviewBtn').onclick = doReview;
  // ⚡: как только в поле адреса оказался bolt11 — сумма не нужна (она в инвойсе); подскажем
  $('#to').addEventListener('input', async () => {
    const isLn = (await import('@/views/lightning.mjs')).looksLikeBolt11($('#to').value);
    const al = $('#amtLabel'); if (al) al.style.display = isLn ? 'none' : '';
    const sp = $('#btcSpeedRow'); if (sp && isLn) sp.hidden = true;
    if (isLn) { const av = $('#avail'); if (av) { av.style.display = ''; av.textContent = '⚡ ' + tr('Lightning invoice detected — the amount is inside it'); } setReview(true); }
  });
  // Max dispatches on the selected currency: asset → its whole quantity; FRC → balance − fee.
  let sendBal = null;
  $('#maxBtn').onclick = async () => {
    const sel = $('#sendAsset');
    if (sel && sel.value === 'BTC') { const max = await mvBtcMax(btcFast()); $('#amt').value = (Number(max) / 1e8).toFixed(8); updBtcFee(); }
    else if (sel && sel.value) $('#amt').value = sel.selectedOptions[0].dataset.qty;
    else if (sendBal != null) $('#amt').value = Math.max(0, sendBal - 0.001).toFixed(8);
  };
  // The selector offers every owned asset (nv3 only) plus BTC when a BTC account is available.
  // On mainnet/testnet there are no user assets, so it's just FRC + BTC.
  if (showCur) (d.MKT() ? mvOwnedAssets() : Promise.resolve([])).then(list => {
    const sel = $('#sendAsset'); if (!sel) return;
    const btc = mvBtc();
    sel.innerHTML = `<option value="">FRC</option>` + list.map(a => `<option value="${a.tag}" data-qty="${a.qty}" data-dec="${a.decimals}">${a.name} (${a.qty.toLocaleString(getLang())})</option>`).join('')
      + (btc.available ? `<option value="BTC">BTC</option>` : '');
    sel.onchange = () => {
      const v = sel.value, isBtc = v === 'BTC', isFrc = !v, dec = +(sel.selectedOptions[0]?.dataset.dec || 0);
      $('#amtLabel').firstChild.textContent = isFrc ? tr('Amount (FRC)') : isBtc ? tr('Amount (BTC)') : tr('Quantity');
      const amt = $('#amt'); amt.step = isBtc || isFrc ? '0.00000001' : String(1 / 10 ** dec); amt.placeholder = isBtc || isFrc ? '0.0' : '0'; amt.value = '';
      $('#to').placeholder = isBtc ? `${btc.hrp}1…` : 'fc1…';
      // available line: FRC balance for FRC, BTC balance for BTC, hidden for assets
      const av = $('#avail'); av.style.display = v && !isBtc ? 'none' : '';
      if (isBtc) { const b = mvBtc().balance; av.textContent = `${tr('available ')}${b != null ? (Number(BigInt(b)) / 1e8).toFixed(8) : '—'} BTC`; }
      else if (isFrc && sendBal != null) av.textContent = `${tr('available ')}${fmt(sendBal)} FRC`;
      // BTC-only speed + live fee block
      $('#btcSpeedRow').hidden = !isBtc;
      if (isBtc) updBtcFee(); else if (isFrc) updFrcCheck(); else setReview(true);
      // token asset: quantity is not a choice — the items are. Swap the amount input for checkboxes.
      const tokCoins = v && !isBtc ? mvTokenCoins(v) : [];
      const pick = $('#sendTokPick');
      pick.hidden = !tokCoins.length;
      $('#amtLabel').hidden = !!tokCoins.length;
      pick.innerHTML = tokCoins.length
        ? tokCoins[0].tokens.map(h => `<label class="chk"><input type="checkbox" data-h="${h}">\ud83c\udf9f ${tokLabel(h)}</label>`).join('') || `<span class="sub">${tr('recovering\u2026')}</span>`
        : '';
    };
  }).catch(() => {});
  $('#amt').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('#reviewBtn')?.disabled) doReview(); });
  $('#amt').addEventListener('input', () => { const v = $('#sendAsset')?.value; if (v === 'BTC') updBtcFee(); else if (!v) updFrcCheck(); });
  $('#btcSpeed').onchange = updBtcFee;
  // Instant: approximate available (verified cache > streamed partial > preview); the verified
  // value replaces it in place and binds Max.
  const seed = d.seedState();
  if (seed) { paintSendAvail(seed, !d.cacheReady()); sendBal = availFrc(seed); }
  else { try { const pv = await d.ds().preview(); if (pv) { paintSendAvail(pv, true); sendBal = availFrc(pv); } } catch {} }
  const sendGen = d.renderGen();
  try { const s = await d.getState(); if (sendGen !== d.renderGen()) return; d.paintBalance(s); paintSendAvail(s, false); sendBal = availFrc(s); updFrcCheck(); }
  catch { if (sendGen !== d.renderGen()) return; const el = $('#avail'); if (el && el.textContent === tr('available…')) el.textContent = ''; }
}


// ---- two-screen flow: the form and the review replace each other inside the modal ----
const showForm = () => { const f = $('#sendForm'); if (f) f.hidden = false; const r = $('#sendResult'); if (r) r.innerHTML = ''; toast(''); };
const showReview = html => { const f = $('#sendForm'); if (f) f.hidden = true; $('#sendResult').innerHTML = html; };
function successScreen(txid, extraToast) {
  $('#to').value = ''; $('#amt').value = '';
  showReview(`<div class="ok">${tr('Sent ✓')}</div><div class="txid">${txid}</div><button id="doneBtn">${tr('Done')}</button>`);
  $('#doneBtn').onclick = () => { const m = document.querySelector('#modal'); if (m) closeOverlay(m); };
  toast(tr('broadcast ✓'));
  if (extraToast) toast(extraToast, 'ok');
}
// ⚡: вставленный bolt11-инвойс в поле адреса — это и есть выбор способа оплаты (никаких
// отдельных вкладок): сумма зашита в инвойсе, комиссия — по маршруту (обычно < 1%).
async function doReviewLn(raw) {
  const ln = await import('@/views/lightning.mjs');
  let dec;
  try { dec = (await import('@core/bolt11.mjs')).decodeBolt11(raw); } catch (e) { return toast(e.message, 'err'); }
  if (dec.sats == null) return toast(tr('invoice must carry an exact amount'), 'err');
  if ((dec.timestamp + dec.expiry) * 1000 < Date.now() + 60e3) return toast(tr('invoice expires too soon — set expiry to 2h+'), 'err');
  // Канал открывается ЗДЕСЬ — в момент, когда его не хватает (а не из настроек): если исходящей
  // ⚡-ёмкости меньше суммы, ревью предлагает открыть канал из BTC-счёта прямо по месту.
  const st = ln.lnLast();
  if (!st || st.outSats < Number(dec.sats)) {
    const btcBal = mvBtc().balance != null ? BigInt(mvBtc().balance) : 0n;
    const chanSats = Math.max(100000, Math.ceil(Number(dec.sats) * 1.3));   // запас на комиссии/резерв
    const canFund = btcBal >= BigInt(chanSats + 2000);
    showReview(
      `<div class="rrow"><span>${tr('Amount')}</span><b>${dec.sats.toLocaleString(getLang())} ${tr('sats')}</b></div>
       <div class="rrow"><span>⚡</span><b class="sub">${tr('not enough Lightning capacity')} (${(st?.outSats ?? 0).toLocaleString(getLang())} ${tr('sats')})</b></div>
       ${canFund
        ? `<div class="sub" style="font-size:12px">${tr('enable instant payments: move')} ${chanSats.toLocaleString(getLang())} ${tr('sats')} ${tr('from your BTC into the ⚡ balance')}. ${tr('it takes ~30 min once, then pay the invoice again')}</div>
           <div class="row"><button id="lnOpenGo">${tr('Enable ⚡ payments')}</button><button id="backBtn" class="ghost">${tr('Back')}</button></div>`
        : `<div class="sub" style="font-size:12px">${tr('not enough BTC to enable ⚡ payments')} (${tr('BTC balance')}: ${btcToStr(btcBal)})</div>
           <div class="row"><button id="backBtn" class="ghost">${tr('Back')}</button></div>`}`);
    $('#backBtn').onclick = showForm;
    const go = $('#lnOpenGo');
    if (go) go.onclick = async e => {
      e.target.disabled = true;
      try {
        await ln.lnOpenChannelSats(chanSats);
        showReview(`<div class="ok">⚡ ${tr('setting up instant payments…')}</div><div class="sub">${tr('it takes ~30 min once, then pay the invoice again')}</div><button id="doneBtn">${tr('Done')}</button>`);
        $('#doneBtn').onclick = () => { const m = document.querySelector('#modal'); if (m) closeOverlay(m); };
      } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
    };
    return;
  }
  showReview(
    `<div class="rrow"><span>${tr('To')}</span><b>⚡ ${short(dec.paymentHash)}</b></div>
     <div class="rrow"><span>${tr('Amount')}</span><b>${dec.sats.toLocaleString(getLang())} ${tr('sats')}</b></div>
     <div class="rrow"><span>${tr('Fee')}</span><b class="sub">${tr('by route, usually <1%')}</b></div>
     <div class="row"><button id="lnConfirm">${tr('Pay')} ⚡</button><button id="backBtn" class="ghost">${tr('Back')}</button></div>`);
  $('#backBtn').onclick = showForm;
  $('#lnConfirm').onclick = async e => {
    e.target.disabled = true;
    try {
      await ln.lnPayBolt(raw);
      $('#to').value = ''; $('#amt').value = '';
      showReview(`<div class="ok">⚡ ${tr('payment started…')}</div><div class="sub">${tr('the result will pop up as a notification')}</div><button id="doneBtn">${tr('Done')}</button>`);
      $('#doneBtn').onclick = () => { const m = document.querySelector('#modal'); if (m) closeOverlay(m); };
    } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
  };
}

async function doReview() {
  { const raw = $('#to').value.trim(); const ln = await import('@/views/lightning.mjs'); if (ln.looksLikeBolt11(raw)) return doReviewLn(raw); }
  if ($('#sendAsset')?.value === 'BTC') return doReviewBtc();
  // A spend must build on VERIFIED chain state; during a first sync/restore that state is still
  // minutes away — say so instead of silently awaiting (the button looked frozen).
  if (!d.cacheReady()) { toast(tr('chain still syncing — sending unlocks once it is verified'), 'warn'); return; }
  const to = $('#to').value.trim(), amt = parseFloat($('#amt').value);
  if (!isValidAddress(to)) return toast(tr('invalid Freicoin address'), 'err');
  const assetTag = $('#sendAsset')?.value || null;
  // Token asset (Freimarkets): the set travels whole — amount is not a choice, the coin is.
  const tokenCoins = assetTag ? mvTokenCoins(assetTag) : [];
  if (assetTag && tokenCoins.length) {
    const name = $('#sendAsset').selectedOptions[0].textContent.replace(/ \(.*\)$/, '');
    const coin = tokenCoins[0];
    const picked = [...document.querySelectorAll('#sendTokPick input:checked')].map(x => /** @type {HTMLElement} */(x).dataset.h);
    if (!picked.length) return toast(tr('add at least one item'), 'err');
    showReview(
      `<div class="rrow"><span>${tr('To')}</span><b>${short(to)}</b></div>
       <div class="rrow"><span>${name}</span><b>${picked.map(h => '\ud83c\udf9f ' + tokLabel(h)).join('<br>')}</b></div>
       <div class="rrow"><span>${tr('Fee')}</span><b>0.00010000 FRC</b></div>
       <div class="row"><button id="confirmBtn">${tr('Send')}</button><button id="cancelBtn" class="ghost">${tr('Cancel')}</button></div>`);
    $('#cancelBtn').onclick = showForm;
    $('#confirmBtn').onclick = async () => {
      const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = tr('broadcasting…');
      try {
        const txid = await mvSendTokenCoin(coin.outpoint, addrToSpk(to), picked);
        successScreen(txid, tokenCoins.length > 1 ? tr('this asset has more token coins — send the next one the same way') : '');
      } catch (e) { toast(tr('broadcast failed: ') + e.message, 'err'); btn.disabled = false; btn.textContent = tr('Send'); }
    };
    return;
  }
  if (!(amt > 0)) return toast(tr('enter an amount'), 'err');
  // Asset branch (Freimarkets): review, then sign+broadcast through the exchange machinery.
  if (assetTag) {
    const name = $('#sendAsset').selectedOptions[0].textContent.replace(/ \(.*\)$/, '');
    showReview(
      `<div class="rrow"><span>${tr('To')}</span><b>${short(to)}</b></div>
       <div class="rrow"><span>${tr('Amount')}</span><b>${amt.toLocaleString(getLang())} ${name}</b></div>
       <div class="rrow"><span>${tr('Fee')}</span><b>0.00010000 FRC</b></div>
       <div class="row"><button id="confirmBtn">${tr('Send')}</button><button id="cancelBtn" class="ghost">${tr('Cancel')}</button></div>`);
    $('#cancelBtn').onclick = showForm;
    $('#confirmBtn').onclick = async () => {
      const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = tr('broadcasting…');
      try {
        const txid = await mvSendAsset(assetTag, amt, addrToSpk(to));
        successScreen(txid);
      } catch (e) { toast(tr('broadcast failed: ') + e.message, 'err'); btn.disabled = false; btn.textContent = tr('Send'); }
    };
    return;
  }
  toast(tr('building…')); $('#reviewBtn').disabled = true;
  try {
    const { utxos, tipHeight, balance } = await d.getState();
    if (amt > balance) throw new Error(`${tr('amount exceeds available')} (${fmt(balance)} FRC)`);
    const r = buildSignedTx({ seed: d.hexSeed(), utxos, toAddress: to, amountFrc: amt, tipHeight });
    d.setPending(r.rawtx);
    showReview(
      `<div class="rrow"><span>${tr('To')}</span><b>${short(to)}</b></div>
       <div class="rrow"><span>${tr('Amount')}</span><b>${fmt(amt)} FRC</b></div>
       <div class="rrow"><span>${tr('Fee')}</span><b>${frc(r.fee)} FRC</b></div>
       <div class="row"><button id="confirmBtn">${tr('Send')}</button><button id="cancelBtn" class="ghost">${tr('Cancel')}</button></div>`);
    $('#confirmBtn').onclick = doBroadcast;
    $('#cancelBtn').onclick = () => { d.setPending(null); showForm(); };
    toast(tr('review the transaction'));
  } catch (e) { toast(e.message, 'err'); }
  finally { $('#reviewBtn').disabled = false; }
}

// BTC send review + confirm — signs locally in market-view, broadcasts via the relay (non-custodial).
async function doReviewBtc() {
  const to = $('#to').value.trim(), amt = parseFloat($('#amt').value);
  if (!mvBtcValidAddr(to)) return toast(tr('bad address'), 'err');
  if (!(amt > 0)) return toast(tr('enter an amount'), 'err');
  // Speed was chosen on the form; carry it into the confirm screen and the send.
  const fast = $('#btcSpeed')?.value === 'fast';
  const { fee, enough } = await mvBtcSendFee(amt, fast);
  if (!enough) return toast(tr('not enough BTC'), 'err');
  showReview(
    `<div class="rrow"><span>${tr('To')}</span><b>${short(to)}</b></div>
     <div class="rrow"><span>${tr('Amount')}</span><b>${amt.toLocaleString(getLang(), { maximumFractionDigits: 8 })} BTC</b></div>
     <div class="rrow"><span>${tr('Speed')}</span><b>${fast ? tr('Fast (next block)') : tr('Economy (cheaper)')}</b></div>
     <div class="rrow"><span>${tr('Fee')}</span><b>${(Number(fee) / 1e8).toFixed(8)} BTC</b></div>
     <div class="row"><button id="confirmBtn">${tr('Send')}</button><button id="cancelBtn" class="ghost">${tr('Cancel')}</button></div>`);
  $('#cancelBtn').onclick = showForm;
  $('#confirmBtn').onclick = async () => {
    const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = tr('broadcasting…');
    try {
      const txid = await mvSendBtc(to, amt, fast);
      successScreen(txid);
    } catch (e) { toast(tr('broadcast failed: ') + e.message, 'err'); btn.disabled = false; btn.textContent = tr('Send'); }
  };
}

async function doBroadcast() {
  const pending = d.getPending();
  if (!pending) return;
  const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = tr('broadcasting…');
  try {
    const { txid } = await d.ds().broadcast(pending);   // seeds both caches with the pending-inclusive state
    d.setPending(null);
    successScreen(txid);
  } catch (e) { toast(tr('broadcast failed: ') + e.message, 'err'); btn.disabled = false; btn.textContent = tr('Send'); }
}
