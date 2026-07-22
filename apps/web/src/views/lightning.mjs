// lightning.mjs — UI ⚡-счёта фазы 2: LN-узел ПРЯМО В КОШЕЛЬКЕ (LDK-wasm в воркере, чейн-фид с
// реле, шифрованный VSS-бэкап на реле, канал к нашему LSP). Ключи из сида, некастодиально.
// Модалка: включить узел → баланс/статус → Получить (инвойс+QR) / Оплатить (bolt11) /
// Открыть канал (funding-tx из BTC-счёта кошелька; LDK бродкастит её сам после обмена подписями).
import QRCode from 'qrcode';
import { $, q } from '@/components/dom.mjs';
import { tr } from '@/services/i18n.mjs';
import { ctx, api } from '@/state/market-ctx.mjs';
import { btcBuildTx, mvBtc, btcToStr } from '@/services/market/btc-account.mjs';
import { lnStart, lnStatus, lnRunning, lnInvoice, lnPayBolt11, lnOpenChannel, lnFundingComplete, lnOn } from '@/services/light/ln/ln-client.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

// наш LSP = fw-lnd на freicoin.ru (алиас freicoin.ru-swap); канал к нему — единственный маршрут,
// который нужен встроенному узлу (никакого gossip)
const LSP_NODE_ID = '032a2826fec45df24589dcabc119d60b1f4be3963016ad184db7a1225c64e40fdc';
const lspWsUrl = () => (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws/lnd';

let wired = false;

async function ensureNode() {
  if (lnRunning()) return lnStatus();
  const st = await api('btcFeedStatus');
  if (st.tip == null) throw new Error(tr('relay chain feed is not ready'));
  // отдельный 32-байтовый LDK-сид из сида кошелька (домен-разделение: компрометация LN-ключей
  // не выдаёт ключи монет, и наоборот)
  const seedBytes = new Uint8Array(sha256(Buffer.from(ctx.seed + ':fw-ln-node', 'utf8')));
  if (!wired) {
    wired = true;
    lnOn('fundingReady', async ({ spkHex, sats }) => {
      try { const { rawtx } = await btcBuildTx(spkHex, sats); await lnFundingComplete(rawtx); paintSoon(); }
      catch (e) { logLine(tr('channel funding failed') + ': ' + e.message); }
    });
    for (const ev of ['channelReady', 'paymentClaimed', 'paymentSent', 'paymentFailed']) lnOn(ev, () => paintSoon());
    lnOn('log', m => logLine(String(m)));
  }
  return lnStart({ seedBytes, net: 'btcmain', apiBase: location.origin + '/api-main', lspWsUrl: lspWsUrl(), lspNodeId: LSP_NODE_ID, anchor: { hash: st.tipHash, height: st.tip } });
}

const logLine = m => { const el = $('#lnLog'); if (el) { el.textContent = (m + '\n' + el.textContent).slice(0, 2000); } };
let paintT = null;
const paintSoon = () => { clearTimeout(paintT); paintT = setTimeout(paintStatus, 300); };
async function paintStatus() {
  const el = $('#lnStat'); if (!el) return;
  try {
    const s = await lnStatus();
    if (!s.running) { el.innerHTML = `<span class="sub">${tr('node is off')}</span>`; return; }
    el.innerHTML = `<div class="rrow"><span>${tr('can send')}</span><b>${s.outSats.toLocaleString()} ${tr('sats')}</b></div>
      <div class="rrow"><span>${tr('can receive')}</span><b>${s.inSats.toLocaleString()} ${tr('sats')}</b></div>
      <div class="rrow"><span>${tr('channels')}</span><b>${s.ready}/${s.channels}</b></div>`;
    const forms = $('#lnForms'); if (forms) forms.style.display = 'block';
    const btn = $('#lnEnable'); if (btn) btn.style.display = 'none';
  } catch (e) { el.textContent = e.message; }
}

export function openLnModal() {
  if ($('#modal')) return;
  const m = document.createElement('div'); m.id = 'modal';
  m.innerHTML = `<div class="review">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>⚡ Lightning</b><button id="lnClose" class="icon">✕</button></div>
    <div class="sub" style="font-size:12px">${tr('a full Lightning node inside your wallet: keys from your phrase, encrypted channel backups on the relay, non-custodial')}</div>
    <div id="lnStat" style="margin:8px 0"><span class="sub">${tr('node is off')}</span></div>
    <button id="lnEnable">${tr('Enable ⚡ node')}</button>
    <div id="lnForms" style="display:none">
      <div class="seg" style="margin:6px 0">
        <button data-ln="recv" class="on">${tr('Receive')}</button>
        <button data-ln="pay">${tr('Pay')}</button>
        <button data-ln="chan">${tr('Channel')}</button>
      </div>
      <div id="lnRecvPane">
        <label class="numfield">${tr('Amount')} (${tr('sats')})<input id="lnRAmt" type="text" inputmode="numeric"></label>
        <button id="lnRGo">${tr('Create invoice')}</button>
        <div id="lnRQr" style="text-align:center;margin:6px 0"></div>
        <div id="lnRInv" class="sub" style="font-size:11px;word-break:break-all"></div>
      </div>
      <div id="lnPayPane" style="display:none">
        <label class="numfield">${tr('Invoice')}<input id="lnPInv" type="text" autocomplete="off" spellcheck="false" placeholder="lnbc…"></label>
        <button id="lnPGo">${tr('Pay')}</button>
      </div>
      <div id="lnChanPane" style="display:none">
        <div class="sub" style="font-size:12px">${tr('open a channel to the exchange LSP, funded from your in-wallet BTC')} (${tr('BTC balance')}: <b>${mvBtc().balance != null ? btcToStr(mvBtc().balance) : '…'}</b>)</div>
        <label class="numfield">${tr('Amount')} (${tr('sats')})<input id="lnCAmt" type="text" inputmode="numeric" placeholder="100000+"></label>
        <button id="lnCGo">${tr('Open channel')}</button>
      </div>
    </div>
    <pre id="lnLog" class="sub" style="font-size:10px;max-height:90px;overflow:auto;white-space:pre-wrap"></pre></div>`;
  document.body.appendChild(m);
  const stop = () => m.remove();
  m.onclick = e => { if (e.target === m) stop(); };
  q(m, '#lnClose').onclick = stop;
  q(m, '.seg').onclick = e => {
    const b = e.target.closest('button[data-ln]'); if (!b) return;
    for (const x of m.querySelectorAll('.seg button')) x.classList.toggle('on', x === b);
    $('#lnRecvPane').style.display = b.dataset.ln === 'recv' ? 'block' : 'none';
    $('#lnPayPane').style.display = b.dataset.ln === 'pay' ? 'block' : 'none';
    $('#lnChanPane').style.display = b.dataset.ln === 'chan' ? 'block' : 'none';
  };
  q(m, '#lnEnable').onclick = async e => {
    e.target.disabled = true; e.target.textContent = tr('starting… (downloading the node, ~24 MB once)');
    try { await ensureNode(); await paintStatus(); }
    catch (err) { logLine(err.message); e.target.disabled = false; e.target.textContent = tr('Enable ⚡ node'); }
  };
  q(m, '#lnRGo').onclick = async () => {
    try {
      const sats = Math.round(Number($('#lnRAmt').value)); if (!(sats > 0)) throw new Error(tr('bad amount'));
      const { bolt11 } = await lnInvoice(sats, 'freicoin.ru wallet');
      $('#lnRInv').textContent = bolt11;
      $('#lnRQr').innerHTML = `<img alt="qr" style="max-width:200px" src="${await QRCode.toDataURL(bolt11.toUpperCase(), { margin: 1 })}">`;
    } catch (e) { logLine(e.message); }
  };
  q(m, '#lnPGo').onclick = async () => {
    try { await lnPayBolt11(($('#lnPInv').value || '').trim().replace(/^lightning:/i, '')); logLine(tr('payment started…')); }
    catch (e) { logLine(e.message); }
  };
  q(m, '#lnCGo').onclick = async () => {
    try {
      const sats = Math.round(Number($('#lnCAmt').value));
      if (!(sats >= 100000)) throw new Error(tr('minimum channel is 100000 sats'));
      await lnOpenChannel(sats); logLine(tr('channel requested — the funding transaction is being built…'));
    } catch (e) { logLine(e.message); }
  };
  if (lnRunning()) paintStatus();
}
