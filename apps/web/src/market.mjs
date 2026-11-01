// market.mjs — the share credit market page (/market): what the market maker buys at, what it
// has bought, and selling a miner's Freicoin share chain credit to it for lightning sats.
//
// The maker (contrib/sharechain/swap/maker.py in the tradecraft sharechain branch, served at
// /maker) builds the hash-locked transfer and fetches the invoice from the seller's lightning
// address; this page signs the transfer with the key of the address that mined, which never
// leaves the browser. The keys come from the freicoin.ru wallet in this browser, from 12 words,
// or from a single WIF key. Until the maker pays, the credit stays the seller's; unpaid, the
// lock lapses by itself.
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

import { sha256 } from '@noble/hashes/sha2.js';
import { $, short, fmt, store, skel } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { openModal, closeOverlay } from '@/components/modal.mjs';
import { tr } from '@/services/i18n.mjs';
import { resolveSecret } from '@/services/wallet.mjs';
import { decryptSecret } from '@/services/vault.mjs';
import { derivePath, ckdPriv, wpkProgramHex } from '@core/hd.mjs';
import { encodeWitness } from '@core/address.mjs';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';

const MAKER = '/maker';
async function api(path, body) {
  const r = await fetch(MAKER + path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// ---- theme: the wallet's choice if this browser has one, else the system's -------------
const mode = store.get('fw_theme_mode') || 'system';
document.documentElement.dataset.theme = mode === 'system'
  ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode;

// ---- keys ----------------------------------------------------------------------------
const secretHex = priv => priv.toString(16).padStart(64, '0');
const addressOf = node => encodeWitness('main', 0, wpkProgramHex(node));

/** Receive addresses of a BIP32 seed on the wallet's path m/84'/0'/0'/0/i. */
function seedKeys(hexSeed, count) {
  const chain = ckdPriv(derivePath(hexSeed, "m/84'/0'/0'"), 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    const node = ckdPriv(chain, i);
    out.push({ address: addressOf(node), secret: secretHex(node.priv) });
  }
  return out;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58check(s) {
  let x = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error(tr('not a WIF key')); x = x * 58n + BigInt(i); }
  let hex = x.toString(16); if (hex.length % 2) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex');
  const zeros = s.length - s.replace(/^1+/, '').length;
  bytes = Buffer.concat([Buffer.alloc(zeros), bytes]);
  const body = bytes.subarray(0, -4), chk = bytes.subarray(-4);
  if (!Buffer.from(sha256(sha256(body))).subarray(0, 4).equals(chk)) throw new Error(tr('not a WIF key'));
  return body;
}
/** A single mainnet WIF key (compressed), as contrib/sharechain/swap/newkey.py makes. */
function wifKey(wif) {
  const b = base58check(wif.trim());
  if (b[0] !== 0x80 || b.length !== 34 || b[33] !== 1) throw new Error(tr('not a compressed mainnet WIF key'));
  const priv = BigInt('0x' + b.subarray(1, 33).toString('hex'));
  return [{ address: addressOf({ priv }), secret: secretHex(priv) }];
}

// ---- page ----------------------------------------------------------------------------
let keys = null, polling = null;
const stopPolling = () => { if (polling) { clearInterval(polling); polling = null; } };

function render() {
  $('#app').innerHTML = `
    <header><h1 style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:600;font-size:26px;line-height:1;margin:0"><a href="/" style="color:inherit;text-decoration:none" title="${tr('Wallet')}">ƒ</a></h1>
      <b>${tr('Share credit market')}</b></header>
    <main class="market">
      <section>
        <div class="sub">${tr('Point your miner at a share chain node with your address as its username. Each share it finds is credit in the share chain: keep it and be paid in FRC when a block is found, or sell it here for sats now.')}
          <a href="/mine">${tr('How to mine')}</a></div>
        <div id="mkOffer" class="sub">${skel(1)}</div>
      </section>
      <section>
        <h2>${tr('Sell your credit')}</h2>
        <div class="sub">${tr('Your key signs the sale in this browser and is never sent anywhere.')}</div>
        <div class="row" id="mkSrc">
          <button id="srcWallet" class="ghost">${tr('Wallet in this browser')}</button>
          <button id="srcWords" class="ghost">${tr('12 words')}</button>
          <button id="srcWif" class="ghost">${tr('Single key (WIF)')}</button>
        </div>
        <div id="mkKeyForm" class="stack"></div>
        <div id="mkList" class="stack"></div>
        <label>${tr('Lightning address for the payment')}<input id="mkLn" type="text" autocomplete="off" spellcheck="false" placeholder="you@wallet.com"></label>
        <label>${tr('At most, sats (optional)')}<input id="mkMax" type="text" inputmode="numeric" placeholder="${tr('everything')}"></label>
        <div id="mkStatus" class="sub"></div>
      </section>
      <section>
        <h2>${tr('Recent sales')}</h2>
        <div id="mkSales" class="sub">${skel(1)}</div>
        <div class="sub"><a href="/market/offers.json">offers.json</a></div>
      </section>
    </main>
    <div id="toast"></div>`;
  $('#mkLn').value = store.get('fw_mk_ln') || '';
  $('#mkLn').onchange = () => store.set('fw_mk_ln', $('#mkLn').value.trim());
  const hasWallet = store.get('fw_seed') || store.get('fw_vault');
  $('#srcWallet').disabled = !hasWallet;
  $('#srcWallet').onclick = walletForm;
  $('#srcWords').onclick = wordsForm;
  $('#srcWif').onclick = wifForm;
  loadOffer();
}

async function loadOffer() {
  try {
    const f = await api('/offers');
    $('#mkOffer').textContent = `${tr('Market maker buys at')} ${f.maker.satsperunit} ${tr('sats per unit of work')} · ${tr('lock')} ${f.maker.expiry} ${tr('chain shares')} · ${tr('up to')} ${fmt(f.maker.maxsats)} ${tr('sats')}`;
    const sales = (f.sales || []).slice(-10).reverse();
    $('#mkSales').innerHTML = sales.length
      ? `<table class="sales"><tr><th>${tr('When')}</th><th>${tr('Seller')}</th><th>${tr('Fruits')}</th><th>${tr('sats')}</th></tr>`
        + sales.map(s => `<tr><td>${new Date(s.time * 1000).toLocaleString()}</td><td title="${s.seller}">${short(s.seller)}</td><td>${fmt(s.fruits)}</td><td>${fmt(s.sats)}</td></tr>`).join('')
        + '</table>'
      : tr('no sales yet');
  } catch (e) {
    $('#mkOffer').textContent = `${tr('the market maker is not reachable')}: ${e.message}`;
    $('#mkSales').textContent = '';
  }
}

const keyForm = html => { $('#mkKeyForm').innerHTML = html; $('#mkList').innerHTML = ''; };

function walletForm() {
  const plain = store.get('fw_seed');
  if (plain) return useSeed(plain, +(store.get('fw_recv') || 0) + 20);
  keyForm(`<label>${tr('Wallet passphrase')}<input id="mkPass" type="password" autocomplete="current-password"></label>
    <div class="row"><button id="mkUnlock">${tr('Unlock')}</button></div>`);
  $('#mkUnlock').onclick = () => {
    try {
      const sec = decryptSecret(JSON.parse(store.get('fw_vault')), $('#mkPass').value);
      $('#mkPass').value = '';
      useSeed(sec, +(store.get('fw_recv') || 0) + 20);
    } catch { toast(tr('wrong passphrase'), 'err'); }
  };
}
function wordsForm() {
  keyForm(`<label>${tr('Recovery phrase (12 words)')}<textarea id="mkWords" rows="3" autocomplete="off" spellcheck="false"></textarea></label>
    <div class="row"><button id="mkUse">${tr('Find my credit')}</button></div>`);
  $('#mkUse').onclick = () => { const w = $('#mkWords').value; $('#mkWords').value = ''; useSeed(w, 40); };
}
function wifForm() {
  keyForm(`<label>${tr('Private key (WIF)')}<input id="mkWif" type="password" autocomplete="off" spellcheck="false"></label>
    <div class="row"><button id="mkUse">${tr('Find my credit')}</button></div>`);
  $('#mkUse').onclick = () => {
    try { keys = wifKey($('#mkWif').value); $('#mkWif').value = ''; showCredit(); }
    catch (e) { toast(e.message, 'err'); }
  };
}
function useSeed(secret, count) {
  try { keys = seedKeys(resolveSecret(secret), Math.min(Math.max(count, 20), 100)); }
  catch (e) { return toast(e.message, 'err'); }
  showCredit();
}

async function showCredit() {
  stopPolling();
  $('#mkKeyForm').innerHTML = `<div class="sub">${tr('Keys loaded for this page only:')} ${keys.length} ${tr('addresses')}</div>`;
  $('#mkList').innerHTML = skel(2);
  let quotes;
  try { quotes = await api('/quotes?addresses=' + keys.map(k => k.address).join(',')); }
  catch (e) { $('#mkList').innerHTML = `<div class="sub">${tr('the market maker is not reachable')}: ${e.message}</div>`; return; }
  const rows = keys.map((k, i) => ({ k, i, q: quotes[k.address] })).filter(r => r.q);
  if (!rows.length) {
    $('#mkList').innerHTML = `<div class="sub">${tr('No share chain credit on these addresses yet.')}</div>`;
    return;
  }
  $('#mkList').innerHTML = rows.map(({ k, i, q }) => `<div class="credit">
      <div class="rrow"><span>${tr('Address')}</span><b title="${k.address}">${short(k.address)}</b></div>
      <div class="rrow"><span>${tr('Fruits in the window')}</span><b>${fmt(q.fruits)}</b></div>
      <div class="rrow"><span>${tr('Offer')}</span><b>${fmt(q.sats)} ${tr('sats')}</b></div>
      <div class="row"><button data-sell="${i}" ${q.sats < Math.max(1, q.minsats) ? 'disabled' : ''}>${tr('Sell')}</button></div>
    </div>`).join('');
  document.querySelectorAll('[data-sell]').forEach(b => b.onclick = () => sell(keys[+b.dataset.sell]));
}

async function sell(k) {
  const ln = $('#mkLn').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ln)) return toast(tr('enter a lightning address'), 'err');
  store.set('fw_mk_ln', ln);
  const maxRaw = $('#mkMax').value.trim();
  const maxsats = maxRaw ? parseInt(maxRaw, 10) : 0;
  if (maxRaw && !(maxsats > 0)) return toast(tr('enter a whole number of sats'), 'err');
  const status = $('#mkStatus');
  status.textContent = tr('preparing the sale…');
  let prep;
  try {
    prep = await api('/prepare', { address: k.address, pubkey: pubkeyCompressed(k.secret), lnaddress: ln, maxsats });
    if (prep.from !== k.address) throw new Error(tr('the maker built a transfer for another address'));
  } catch (e) { status.textContent = ''; return toast(e.message, 'err'); }
  const m = openModal(tr('Sell share credit'),
    `<div class="stack">
       <div class="rrow"><span>${tr('From')}</span><b>${short(k.address)}</b></div>
       <div class="rrow"><span>${tr('You receive')}</span><b>${fmt(prep.sats)} ${tr('sats')}</b></div>
       <div class="rrow"><span>${tr('To')}</span><b>${ln}</b></div>
       <div class="sub">${tr('The credit is locked for the maker and moves only when your wallet is paid; if it is not paid, the lock lapses and the credit stays yours.')}</div>
       <div class="row"><button id="mkGo">${tr('Sell')}</button><button id="mkNo" class="ghost">${tr('Cancel')}</button></div>
     </div>`);
  m.querySelector('#mkNo').onclick = () => { closeOverlay(m); status.textContent = ''; };
  m.querySelector('#mkGo').onclick = async () => {
    closeOverlay(m);
    try {
      const signature = signEcdsa(k.secret, prep.sighash);
      const { txid } = await api('/submit', { hex: prep.hex, signature, invoice: prep.invoice });
      follow(txid, prep.sats, ln);
    } catch (e) { status.textContent = ''; toast(e.message, 'err'); }
  };
}

function follow(txid, sats, ln) {
  const status = $('#mkStatus');
  const started = Date.now();
  const tick = async () => {
    let s;
    try { s = await api('/status?txid=' + txid); } catch { return; }
    if (s.state === 'paid') {
      stopPolling();
      status.textContent = `${tr('Paid')}: ${fmt(sats)} ${tr('sats')} → ${ln}`;
      toast(tr('sold ✅'));
      loadOffer();
      return;
    }
    status.textContent = s.state === 'waiting' ? tr('waiting for a chain share to carry the sale…')
      : s.state === 'locked' ? (s.paying ? tr('the maker is paying…') : tr('locked for the maker, payment on its way…'))
      : tr('checking…');
    if (Date.now() - started > 60 * 60 * 1000) {   // a lock lasts ~30 chain shares: well past it
      stopPolling();
      status.textContent = tr('not paid: the lock lapses and the credit stays yours');
    }
  };
  stopPolling();
  polling = setInterval(tick, 5000);
  tick();
}

render();
