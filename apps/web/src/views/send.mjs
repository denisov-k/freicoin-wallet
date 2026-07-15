// views/send.mjs — money movement: the Receive modal (QR + address) and the Send modal with its
// review/broadcast flow (FRC, user assets, and non-custodial BTC). The data-plane it reads and
// mutates (pending tx, verified cache, receive index, light-source lifecycle) lives in the app
// shell and is injected via initSend — the view never reassigns shell state directly.
import { $, copy, short, fmt } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { openModal, closeOverlay } from '@/components/modal.mjs';
import { tr, getLang } from '@/services/i18n.mjs';
import QRCode from 'qrcode';
import { deriveAddress, isValidAddress, addrToSpk, buildSignedTx } from '@/services/wallet.mjs';
import { mvBtc, mvBtcAddress, mvBtcValidAddr, mvSendBtc, mvOwnedAssets, mvSendAsset, mvTokenCoins, mvSendTokenCoin, tokLabel } from '@/views/exchange.mjs';

/** deps injected by the app shell (see main.mjs initSend) */
let d;
export const initSend = deps => { d = deps; };

export function paintSendAvail(st, approx) {
  const el = $('#avail');
  if (el && st) el.textContent = `${tr('available ')}${approx ? '≈ ' : ''}${fmt(st.balance)} FRC`;   // full precision — meant to be spent
}

export function renderReceive() {
  // Open in a loading state (shimmering QR + address placeholders), then fill in.
  const btcOn = d.SWAP() && mvBtc().available;
  openModal(tr('Receiving'),
    (btcOn ? `<label>${tr('Currency')}<select id="rcvCur"><option value="FRC">FRC</option><option value="BTC">BTC</option></select></label>` : '')
    + `<div id="qrBox" class="qr skel" style="margin:0 auto;height:220px"></div>
     <div class="addr" id="addr"><div class="skel-line" style="height:14px;width:85%;margin:3px auto"></div></div>
     <div class="row"><button id="copyAddr" class="ghost" disabled>⧉ ${tr('Copy')}</button></div>
     <div class="row" id="newAddrRow"><button id="newAddr" class="ghost">${tr('New address')}</button></div>`);
  // FRC = a fresh HD address; BTC = the single (fixed) account address, so "New address" hides for BTC.
  const fill = async isBtc => {
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
  // Fresh FRC address: bump the index + repaint at once, then grow the watch window off-frame.
  $('#newAddr').onclick = () => { d.bumpRecv(); fill(false); d.growWatchAfterNewAddr(); };
  fill(false);
}

export async function renderSend() {
  d.setPending(null);
  openModal(tr('Send'),
    `<div id="sendForm" class="stack">
     <div class="sub" id="avail">${tr('available…')}</div>
     ${d.MKT() ? `<label>${tr('Asset')}<select id="sendAsset"><option value="">FRC</option></select></label>` : ''}
     <label>${tr('To address')}<input id="to" placeholder="fc1…" autocomplete="off"></label>
     <label id="amtLabel">${tr('Amount (FRC)')}<div class="amtrow"><input id="amt" type="number" step="0.00000001" min="0" placeholder="0.0"><button id="maxBtn" class="ghost">${tr('Max')}</button></div></label>
     <div class="stack" id="sendTokPick" hidden></div>
     <button id="reviewBtn">${tr('Review')}</button></div><div id="sendResult" class="stack"></div>`);
  $('#reviewBtn').onclick = doReview;
  // Max dispatches on the selected currency: asset → its whole quantity; FRC → balance − fee.
  let sendBal = null;
  $('#maxBtn').onclick = () => {
    const sel = $('#sendAsset');
    if (sel && sel.value === 'BTC') { const b = mvBtc().balance; $('#amt').value = b ? Math.max(0, (Number(BigInt(b)) - 1000) / 1e8).toFixed(8) : '0'; }
    else if (sel && sel.value) $('#amt').value = sel.selectedOptions[0].dataset.qty;
    else if (sendBal != null) $('#amt').value = Math.max(0, sendBal - 0.001).toFixed(8);
  };
  // Freimarkets: the selector offers every owned asset (+ BTC when a BTC account is available).
  if (d.MKT()) mvOwnedAssets().then(list => {
    const sel = $('#sendAsset'); if (!sel) return;
    const btc = mvBtc();
    sel.innerHTML = `<option value="">FRC</option>` + list.map(a => `<option value="${a.tag}" data-qty="${a.qty}" data-dec="${a.decimals}">${a.name} (${a.qty.toLocaleString(getLang())})</option>`).join('')
      + (btc.available ? `<option value="BTC">BTC</option>` : '');
    sel.onchange = () => {
      const v = sel.value, isBtc = v === 'BTC', isFrc = !v, dec = +(sel.selectedOptions[0]?.dataset.dec || 0);
      $('#amtLabel').firstChild.textContent = isFrc ? tr('Amount (FRC)') : isBtc ? tr('Amount (BTC)') : tr('Quantity');
      const amt = $('#amt'); amt.step = isBtc || isFrc ? '0.00000001' : String(1 / 10 ** dec); amt.placeholder = isBtc || isFrc ? '0.0' : '0'; amt.value = '';
      $('#to').placeholder = isBtc ? `${btc.hrp}1…` : 'fc1…';
      $('#avail').style.display = isFrc ? '' : 'none';   // the FRC line doesn't describe an asset/BTC
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
  $('#amt').addEventListener('keydown', e => { if (e.key === 'Enter') doReview(); });
  // Instant: approximate available (verified cache > streamed partial > preview); the verified
  // value replaces it in place and binds Max.
  const seed = d.seedState();
  if (seed) paintSendAvail(seed, !d.cacheReady());
  else { try { const pv = await d.ds().preview(); if (pv) paintSendAvail(pv, true); } catch {} }
  const sendGen = d.renderGen();
  try { const s = await d.getState(); if (sendGen !== d.renderGen()) return; d.paintBalance(s); paintSendAvail(s, false); sendBal = s.balance; }
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
async function doReview() {
  if ($('#sendAsset')?.value === 'BTC') return doReviewBtc();
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
       <div class="rrow"><span>${tr('Fee')}</span><b>${(Number(r.fee) / 1e8).toFixed(8)} FRC</b></div>
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
  showReview(
    `<div class="rrow"><span>${tr('To')}</span><b>${short(to)}</b></div>
     <div class="rrow"><span>${tr('Amount')}</span><b>${amt.toLocaleString(getLang(), { maximumFractionDigits: 8 })} BTC</b></div>
     <div class="rrow"><span>${tr('Fee')}</span><b>0.00001000 BTC</b></div>
     <div class="row"><button id="confirmBtn">${tr('Send')}</button><button id="cancelBtn" class="ghost">${tr('Cancel')}</button></div>`);
  $('#cancelBtn').onclick = showForm;
  $('#confirmBtn').onclick = async () => {
    const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = tr('broadcasting…');
    try {
      const txid = await mvSendBtc(to, amt);
      successScreen(txid);
    } catch (e) { toast(tr('broadcast failed: ') + e.message, 'err'); btn.disabled = false; btn.textContent = tr('Send'); }
  };
}

async function doBroadcast() {
  const pending = d.getPending();
  if (!pending) return;
  const btn = $('#confirmBtn'); btn.disabled = true; btn.textContent = tr('broadcasting…');
  try {
    const { txid } = await d.ds().broadcast(pending);
    d.setPending(null); d.resetCache();
    successScreen(txid);
  } catch (e) { toast(tr('broadcast failed: ') + e.message, 'err'); btn.disabled = false; btn.textContent = tr('Send'); }
}
