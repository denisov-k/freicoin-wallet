// views/mining.mjs — the Mining tab (mainnet): this wallet's addresses that hold share chain
// credit, and selling that credit to the market maker for lightning sats before a block pays it.
// The maker (contrib/sharechain/swap/maker.py in the tradecraft sharechain branch, behind
// /maker) builds the hash-locked transfer and fetches the invoice from the seller's lightning
// address; this page signs the transfer with the address's key, which never leaves the page.
// Until the maker pays the invoice the credit stays the seller's; if it never pays, the lock
// lapses by itself.
import { $, short, fmt, store, skel } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { openModal, closeOverlay } from '@/components/modal.mjs';
import { tr } from '@/services/i18n.mjs';
import { accountPath } from '@/services/wallet.mjs';
import { derivePath, ckdPriv, wpkProgramHex } from '@core/hd.mjs';
import { encodeWitness } from '@core/address.mjs';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';

/** deps injected by the app shell: hexSeed(), addressCount() */
let d;
export const initMining = deps => { d = deps; };

const MAKER = '/maker';
async function api(path, body) {
  const r = await fetch(MAKER + path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// The wallet's receive addresses with their keys (BIP84 m/84'/0'/0'/0/i, the wallet's own path).
function receiveKeys(n) {
  const chain = ckdPriv(derivePath(d.hexSeed(), accountPath()), 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const node = ckdPriv(chain, i);
    out.push({ index: i, node, address: encodeWitness('main', 0, wpkProgramHex(node)) });
  }
  return out;
}
const secretOf = node => node.priv.toString(16).padStart(64, '0');

let polling = null;
const stopPolling = () => { if (polling) { clearInterval(polling); polling = null; } };

export async function renderMining() {
  const el = $('#mining'); if (!el) return;
  stopPolling();
  el.innerHTML = `
    <div class="stack">
      <div class="sub">${tr('Point your miner at a share chain node with one of this wallet\'s addresses as its username. Each share it finds is credit in the share chain: keep it and be paid in FRC when a block is found, or sell it here for sats now.')}
        <a href="/mine">${tr('How to mine')}</a></div>
      <div class="sub" id="mkOffer"></div>
      <div id="mkList">${skel(2)}</div>
      <label>${tr('Lightning address for the payment')}<input id="mkLn" type="text" autocomplete="off" spellcheck="false" placeholder="you@wallet.com"></label>
      <label>${tr('At most, sats (optional)')}<input id="mkMax" type="text" inputmode="numeric" placeholder="${tr('everything')}"></label>
      <div id="mkStatus" class="sub"></div>
    </div>`;
  $('#mkLn').value = store.get('fw_mk_ln') || '';
  $('#mkLn').onchange = () => store.set('fw_mk_ln', $('#mkLn').value.trim());
  let offer, keys, quotes;
  try {
    offer = (await api('/offers')).maker;
    $('#mkOffer').textContent = `${tr('Market maker buys at')} ${offer.satsperunit} ${tr('sats per unit of work')} · ${tr('lock')} ${offer.expiry} ${tr('chain shares')}`;
    keys = receiveKeys(d.addressCount());
    quotes = await api('/quotes?addresses=' + keys.map(k => k.address).join(','));
  } catch (e) {
    $('#mkList').innerHTML = `<div class="sub">${tr('the market maker is not reachable')}: ${e.message}</div>`;
    return;
  }
  const rows = keys.filter(k => quotes[k.address]);
  if (!rows.length) {
    $('#mkList').innerHTML = `<div class="sub">${tr('No share chain credit on this wallet\'s addresses yet.')}</div>`;
    return;
  }
  $('#mkList').innerHTML = rows.map(k => {
    const qt = quotes[k.address];
    return `<div class="card stack" style="padding:10px">
      <div class="rrow"><span>${tr('Address')}</span><b title="${k.address}">${short(k.address)}</b></div>
      <div class="rrow"><span>${tr('Fruits in the window')}</span><b>${fmt(qt.fruits)}</b></div>
      <div class="rrow"><span>${tr('Offer')}</span><b>${fmt(qt.sats)} ${tr('sats')}</b></div>
      <div class="row"><button data-sell="${k.index}" ${qt.sats < Math.max(1, qt.minsats) ? 'disabled' : ''}>${tr('Sell')}</button></div>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-sell]').forEach(b => b.onclick = () => sell(keys[+b.dataset.sell], quotes[keys[+b.dataset.sell].address]));
}

async function sell(k, qt) {
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
    const secret = secretOf(k.node);
    prep = await api('/prepare', { address: k.address, pubkey: pubkeyCompressed(secret), lnaddress: ln, maxsats });
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
      const signature = signEcdsa(secretOf(k.node), prep.sighash);
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
    if (!$('#mkStatus')) return stopPolling();
    if (s.state === 'paid') {
      stopPolling();
      status.textContent = `${tr('Paid')}: ${fmt(sats)} ${tr('sats')} → ${ln}`;
      toast(tr('sold ✅'));
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
