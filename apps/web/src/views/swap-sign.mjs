// views/swap-sign.mjs — the wallet's half of "Connect FRC wallet".
//
// A page elsewhere on this origin (the swap desk at /swap) needs coins locked into a hashed
// timelock. It cannot do that itself: the seed lives here. So it opens this route in a popup and
// this view signs — but only after deciding for itself that the lock is one it should fund.
//
// The rule that makes a stray link harmless: NOTHING about the lock is taken from the caller.
// The caller passes a swap id and nothing else. The terms come from the swap daemon, the lock
// script is rebuilt here from those terms, and two things must hold before a confirm screen is
// even shown:
//   • the address we derive must equal the one the daemon claims, and
//   • the refund key in that lock must be OUR key, so a timeout pays us and nobody else.
// A hand-crafted link can therefore only ever point at a real offer whose refund path is ours.
import { $, frc, short } from '@/components/dom.mjs';
import { openModal, closeOverlay } from '@/components/modal.mjs';
import { toast } from '@/components/toast.mjs';
import { tr } from '@/services/i18n.mjs';
import { htlcLeaf, htlcAddress } from '@core/htlc.mjs';
import { pubkeyCompressed } from '@core/ecdsa.mjs';
import { derivePath } from '@core/hd.mjs';
import { buildSignedTx, deriveAddress } from '@/services/wallet.mjs';

/** deps injected by the app shell (see main.mjs initSwapSign) */
let d;
export const initSwapSign = deps => { d = deps; };

const API = '/api-ton/api';
const call = (m, body) => fetch(`${API}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  .then(async r => { const j = await r.json(); if (j.error) throw new Error(j.error); return j; });

// A key reserved for swaps, derived from the same seed but off the spending path, so a swap
// refund never collides with ordinary change. m/84'/0'/0'/2/0 — chain 2 is unused by the wallet.
const SWAP_PATH = "/2/0";
const swapKeyOf = seed => {
  const acct = d.account();                    // m/84'/coinType'/0'
  const node = derivePath(seed, acct + SWAP_PATH);
  return node.priv.toString(16).padStart(64, '0');
};

/** Answer a "connect" request: hand back a public key and a payout address. Never the seed. */
export function swapConnect() {
  const seed = d.hexSeed();
  return { pub: pubkeyCompressed(swapKeyOf(seed)), payout: deriveAddress(seed, 0, 0) };
}

/** Show the confirmation for swap `id` and, if approved, fund and broadcast the lock. */
export async function swapSignLock(id, reply) {
  let t;
  try { t = await call('statusReverse', { id }); }
  catch (e) { return fail(reply, tr('сделка не найдена: ') + e.message); }

  // rebuild the lock from the terms — the caller's word is not evidence
  const seed = d.hexSeed();
  const myPub = pubkeyCompressed(swapKeyOf(seed));
  const leaf = htlcLeaf({ paymentHash: t.hash, claimPub: t.frcClaimPub, refundPub: t.frcRefundPub, cltv: t.frcCltv });
  const addr = htlcAddress(leaf, t.net === 'main' ? 'main' : t.net);

  if (t.frcRefundPub !== myPub) {
    return fail(reply, tr('возврат по этому замку настроен не на этот кошелёк — подписывать нельзя'));
  }
  if (addr !== t.frcAddress) {
    return fail(reply, tr('замок не сходится с условиями сделки — подписывать нельзя'));
  }
  if (t.state !== 'awaiting-frc') {
    return fail(reply, tr('эта сделка уже не ждёт оплаты (') + t.state + ')');
  }

  const amount = BigInt(t.frcAmount);
  const jettons = (Number(t.jettons) / 10 ** (t.decimals ?? 9)).toLocaleString('ru-RU');
  const blocks = t.frcCltv - t.tip;

  const m = openModal(tr('Подтвердить обмен'), `
    <div class="rrow"><span>${tr('Отдаёшь')}</span><b>${frc(amount)} FRC</b></div>
    <div class="rrow"><span>${tr('Получаешь')}</span><b>${jettons} ${t.symbol || ''}</b></div>
    <div class="rrow"><span>${tr('На кошелёк')}</span><b>${short(t.tonRecipient)}</b></div>
    <div class="rrow"><span>${tr('Замок до блока')}</span><b>${t.frcCltv} · ~${blocks} ${tr('бл.')}</b></div>
    <p class="sub" style="font-size:12px">${tr('Монеты запираются: их заберёт вторая сторона, только предъявив секрет. Если обмен не состоится, они вернутся на этот кошелёк после указанного блока.')}</p>
    <div class="sub" id="ssLog" style="font-size:12px;white-space:pre-line"></div>
    <button id="ssYes" class="primary">${tr('Запереть и обменять')}</button>
    <button id="ssNo" class="ghost">${tr('Отмена')}</button>`);

  const log = m => { const el = $('#ssLog'); if (el) el.textContent = m; };
  $('#ssNo').onclick = () => { closeOverlay(m); reply({ error: 'отменено пользователем' }); };
  const yes = /** @type {HTMLButtonElement} */ ($('#ssYes'));
  yes.onclick = async () => {
    if (!d.cacheReady()) {                    // chain not verified yet — Send gates on this too
      log(tr('Цепь ещё синхронизируется — дождись «synced ✓» вверху и нажми снова.'));
      return;
    }
    yes.disabled = true;
    try {
      log(tr('подписываем…'));
      const st = await d.getState();          // cached; ready() above guarantees it exists
      if (!st?.utxos?.length) throw new Error(tr('нет монет на этом кошельке для оплаты'));
      const { rawtx } = buildSignedTx({
        seed, utxos: st.utxos, toAddress: addr,
        amountFrc: Number(amount) / 1e8, tipHeight: st.tipHeight,
      });
      log(tr('отправляем в сеть…'));
      const { txid } = await d.broadcast(rawtx);
      closeOverlay(m);
      toast(tr('монеты заперты — возвращайся на страницу обмена'));
      reply({ txid, address: addr });
    } catch (e) {
      log(tr(e.message || 'не вышло'));
      yes.disabled = false;
    }
  };
}

function fail(reply, msg) {
  const m = openModal(tr('Обмен'), `<p>${msg}</p><button id="ssNo" class="ghost">${tr('Закрыть')}</button>`);
  $('#ssNo').onclick = () => { closeOverlay(m); reply({ error: msg }); };
}
