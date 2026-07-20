// swap-drive.mjs — the P2P swap ENGINE (both directions + partial children): advance each of MY
// swaps on every tick, acting only on my turn, and auto-refund a locked leg once its timelock passes.
//
// PURE of any browser/runtime specifics: everything the engine needs — the live session (state/keys),
// the relay, swap-record storage, FRC/BTC coin ops, on-chain verification, fees, and UI/telemetry
// side effects — is injected as ONE `env` object via initDrive(env). The browser wallet and the
// headless server bot each build their own `env` (see initMarketView / the bot's server adapter) and
// call the SAME engine, so there is a single source of truth for the protocol. Only core/* (the pure
// crypto/tx/HTLC/swap builders) is imported directly.
import { htlcClaimAsset, htlcRefundAsset, htlcSpk, htlcCoopRefundHost, htlcCoopRefundAsset } from '@core/htlc.mjs';
import { frcLeg, refundGiven, claimReceived } from '@core/swap.mjs';
import { btcHtlcClaim, btcHtlcRefund, btcHtlcLeaf, btcHtlcAddress, btcHtlcSpk, btcHtlcCoopSig, btcHtlcCoopRefund, btcP2wpkhSpk } from '@core/btc.mjs';
import { assetPresentValue } from '@core/assets.mjs';
import { pubkeyCompressed } from '@core/ecdsa.mjs';

/**
 * The injected environment. Adapters (browser / server) provide these.
 * @typedef {object} SwapEnv
 * @property {() => any} state         live session: { info, mine:{height,utxos}, swap, p2p }
 * @property {() => string[]} spks     my scripts; spks[0] is the receive address the claims pay to
 * @property {(nonce:string, leg:string)=>string} p2pKey   per-swap key from the seed
 * @property {(method:string, params?:any)=>Promise<any>} api   relay call
 * @property {()=>any[]} loadP2p
 * @property {(rec:any)=>void} putP2p
 * @property {(id:string)=>void} dropP2p
 * @property {(h:any)=>void} addSwapHist
 * @property {(txid:string)=>void} addRefundedFund
 * @property {(refh:number|bigint, need:bigint)=>any} hostFeeCoin
 * @property {(spk:string, amount:bigint)=>Promise<{txid:string,vout:number,refheight?:number}>} sendFrcToSpk
 * @property {(spk:string, tag:string, amount:bigint)=>Promise<{txid:string,vout:number,refheight?:number}>} lockAssetToHtlc
 * @property {(addr:string, sats:bigint)=>Promise<{txid:string,vout:number,value:any}>} btcFundHtlc
 * @property {()=>string} btcAcctPub
 * @property {()=>string} btcHrp
 * @property {()=>any} refreshBtc
 * @property {(o:any)=>Promise<any>} verifyFrcOutput
 * @property {(o:any)=>Promise<any>} verifyBtcOutput
 * @property {(tag:string)=>any} rateOf
 * @property {()=>string} swapNet
 * @property {()=>bigint} btcSpendFee     current BTC HTLC claim/refund fee (tracks the live feerate)
 * @property {(m:string, kind?:string)=>void} toast
 * @property {()=>void} mvRefresh
 * @property {(rawtx:string)=>any} [observe]   reflect a tx we built into the local balance/activity
 * @property {(s:string)=>string} tr           i18n (identity is fine for a headless bot)
 */

/** @type {SwapEnv} */
let env = /** @type {any} */ ({});
export function initDrive(e) { env = e; if (!env.observe) env.observe = () => {}; if (!env.tr) env.tr = s => s; }

// AUTO-REFUND (FRC/asset leg): a leg I locked (forward maker: frc_funded; reverse taker: frc_funded_rev)
// that never completed comes back to me once its CLTV passes — a plain HTLC refund can't be instant (the
// timelock IS the atomic-swap safety), but the funds must not sit locked forever either.
export async function checkP2pRefunds() {
  const { tr, api, p2pKey } = env;
  const h = env.state().mine.height;
  for (const rec of env.loadP2p()) {
    try {
      // forward maker (frc_funded) and reverse taker (frc_funded_rev) both lock the FRC/asset HTLC
      const isMaker = rec.role === 'maker' && rec.status === 'frc_funded' && rec.leaf && rec.funding?.txid;
      const isRevTaker = rec.dir === 'sellBtc' && rec.role === 'taker' && rec.status === 'frc_funded_rev' && rec.funding?.txid;
      if (!isMaker && !isRevTaker) continue;
      // reverse taker's leaf/cltv come from the relay record (its own funding stored only txid/vout)
      let leaf = rec.leaf, cltv = rec.T1, funding = rec.funding, tag = rec.assetTag ?? null;
      let w; try { w = (await api('p2pList')).swaps.find(s => s.id === rec.id); } catch { w = null; }
      if (isRevTaker) {
        if (!w?.frcHtlc) continue;
        leaf = w.frcHtlc.leaf; cltv = w.frcHtlc.cltv; tag = w.assetTag ?? w.frcHtlc.assetTag ?? null;
        funding = { txid: rec.funding.txid, vout: rec.funding.vout ?? 0, value: w.frcHtlc.value, refheight: w.frcHtlc.refheight };
      }
      const live = await api('utxos', { spks: [htlcSpk(leaf)] }).then(r => (r.utxos || []).find(u => u.outpoint === `${funding.txid}:${funding.vout}`)).catch(() => null);
      if (!live) {
        // v2 ORDER FLIP: the taker CLAIMING my lock is not the end of my swap — I still collect
        // the BTC side after (frc_claimed → p2pBtcClaim). Dropping the record here orphaned that
        // claim. Drop only when the swap is gone/terminal — the drive owns the happy path.
        if (!w || ['done', 'cancelled', 'expired'].includes(w.status)) env.dropP2p(rec.id);
        continue;
      }
      const ourKey = p2pKey(rec.nonce, 'frc');
      // INSTANT cooperative refund: the other side submitted a coop signature → no timelock wait.
      // ISOLATED: a bogus coopSig (anyone can POST one to the relay) must NOT block the timeout
      // refund safety net — if the coop attempt fails, fall through to the CLTV path below.
      if (w?.coopSig) {
        try {
          const refh = Number(funding.refheight);
          let cr;
          if (tag) {
            const feeCoin = env.hostFeeCoin(refh, 11000n);   // must be OLDER than the HTLC (valued at refh)
            if (!feeCoin) throw new Error(tr('you need an older FRC coin (tap Faucet) for the network fee'));
            cr = htlcCoopRefundAsset({ funding: { txid: funding.txid, vout: funding.vout, value: BigInt(live.value), refheight: refh }, leafHex: leaf, refundKey: ourKey, otherSig: w.coopSig, toSpk: env.spks()[0], assetTag: tag, feeCoin, fee: 0n });
          } else {
            cr = htlcCoopRefundHost({ funding: { txid: funding.txid, vout: funding.vout, value: BigInt(live.value), refheight: refh }, leafHex: leaf, refundKey: ourKey, otherSig: w.coopSig, toSpk: env.spks()[0], fee: 10000n });
          }
          await api('tx', { rawtx: cr.rawtx, kind: 'send' }); try { env.observe(cr.rawtx); } catch {}   // reflect it in the wallet's balance/activity now
          env.dropP2p(rec.id);
          env.toast(`${rec.id}: ${tr(tag ? 'asset refunded (cancelled)' : 'FRC refunded (cancelled)')}`, 'ok'); env.mvRefresh();
          continue;
        } catch { /* invalid/foreign coopSig — ignore it and let the timeout refund below run */ }
      }
      if (h <= cltv + 1) continue;                          // CLTV not reached yet — nothing to do
      let rf;
      if (tag) {   // asset refund: whole asset back to me (present-valued), fee from a host coin
        const feeCoin = env.hostFeeCoin(h, 11000n);
        if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
        const payout = assetPresentValue(BigInt(live.value), h - Number(funding.refheight), env.rateOf(tag));
        rf = htlcRefundAsset({ funding: { txid: funding.txid, vout: funding.vout, value: BigInt(live.value), refheight: Number(funding.refheight) }, leafHex: leaf, cltv, refundKey: ourKey, toSpk: env.spks()[0], assetTag: tag, payout, feeCoin, fee: 0n, lockHeight: h });
      } else {
        rf = refundGiven({ funding: { txid: funding.txid, vout: funding.vout, value: BigInt(live.value), refheight: Number(funding.refheight) }, leaf, cltv, ourKey, toSpk: env.spks()[0], fee: 10000n });
      }
      await api('tx', { rawtx: rf.rawtx, kind: 'send' }); try { env.observe(rf.rawtx); } catch {}   // reflect it in the wallet's balance/activity now
      env.dropP2p(rec.id);
      env.toast(`${rec.id}: ${tr(tag ? 'asset refunded' : 'FRC refunded')}`, 'ok'); env.mvRefresh();
    } catch (e) { /* too early, coin gone, or missing fee coin — retry next cycle */ }
  }
}

// AUTO-REFUND (BTC leg): whoever funded a BTC HTLC that never completed sweeps it home once its
// CLTV passes — the forward BUYER (far leg, seller never locked/claimed) and the v2 reverse MAKER
// (near leg, taker never claimed). Nobody has to babysit the tab for the money to come home.
export async function checkBtcRefunds() {
  const { tr, api, p2pKey } = env;
  if (!env.state()?.swap?.available) return;
  const mine = env.loadP2p().filter(r => ((r.role === 'taker' && r.dir !== 'sellBtc') || (r.role === 'maker' && r.dir === 'sellBtc'))
    && r.btcHtlc?.txid && r.btcHtlc.leaf && r.btcHtlc.cltv != null);
  if (!mine.length) return;
  let info; try { info = await api('p2pList'); } catch { return; }
  const bh = info.btcHeight || 0, byId = new Map((info.swaps || []).map(s => [s.id, s]));
  // COOP CANCEL (forward taker): I paid BTC, asked to cancel, and the seller AUTHORIZED it
  // (btcCoopSig) — sweep my BTC home instantly via the coop branch, no timeout wait.
  for (const rec of mine) {
    const w = byId.get(rec.id);
    if (rec.role !== 'taker' || !w?.btcCoopSig || w.preimage || w.frcHtlc?.txid) continue;
    try {
      const b = rec.btcHtlc;
      const cr = btcHtlcCoopRefund({ prevTxid: b.txid, vout: b.vout ?? 0, valueSats: BigInt(b.value), leafHex: b.leaf,
        refundKey: p2pKey(rec.nonce, 'btc'), otherSig: w.btcCoopSig, toSpk: btcP2wpkhSpk(env.btcAcctPub()), fee: env.btcSpendFee() });
      await api('btcBroadcast', { rawtx: cr.rawtx });
      env.addRefundedFund(b.txid);
      await api('p2pBtcCancelled', { id: rec.id, takerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) }).catch(() => {});
      env.dropP2p(rec.id);
      env.toast(`${rec.id}: ${tr('purchase cancelled — BTC returned')}`, 'ok'); env.refreshBtc(); env.mvRefresh();
    } catch { /* seller not yet signed, or already swept — retry */ }
  }
  for (const rec of mine) {
    try {
      const b = rec.btcHtlc, w = byId.get(rec.id);
      if (w?.preimage) continue;          // R revealed → the seller took the BTC; I claim FRC instead (driveP2p)
      if (bh <= b.cltv) continue;         // T2 not reached yet — the swap can still complete normally
      const rf = btcHtlcRefund({ prevTxid: b.txid, vout: b.vout ?? 0, valueSats: BigInt(b.value), leafHex: b.leaf, cltv: b.cltv, refundKey: p2pKey(rec.nonce, 'btc'), toSpk: btcP2wpkhSpk(env.btcAcctPub()), fee: env.btcSpendFee() });
      await api('btcBroadcast', { rawtx: rf.rawtx });
      env.addRefundedFund(b.txid);        // this swap round-tripped (out then back) — un-hide the funding send so the ledger explains the fee
      env.dropP2p(rec.id);
      env.toast(`${rec.id}: ${tr('BTC refunded (seller offline)')}`, 'ok'); env.refreshBtc(); env.mvRefresh();
    } catch (e) { /* too early, output already claimed, or broadcast rejected — retry next cycle */ }
  }
}

// DRIVE: advance each of MY p2p swaps on every refresh, acting only on my turn.
// Serialized: overlapping invocations (interval + visibility kick) must not both act on the same
// swap — that is how an HTLC got funded twice when a report to the relay failed mid-cycle.
let p2pDriving = false;
export async function driveP2p() {
  if (p2pDriving) return;
  p2pDriving = true;
  try { await driveP2pInner(); } finally { p2pDriving = false; }
}
async function driveP2pInner() {
  const { tr, api, p2pKey } = env;
  let mine = env.loadP2p(); if (!env.state()) return;
  let info; try { info = await api('p2pList'); } catch { return; }
  // v2 heartbeat: keep my open offers alive (the relay expires offers whose maker went dark —
  // a dead offer would strand the first-mover taker's real payment)
  const offerRecs = mine.filter(r => r.role === 'maker' && (r.status === 'open' || r.partial));
  if (offerRecs.length) { try { await api('p2pPing', { pubs: [...new Set(offerRecs.map(r => pubkeyCompressed(p2pKey(r.nonce, 'frc'))))] }); } catch {} }
  if (!mine.length) return;
  const byId = new Map(info.swaps.map(s => [s.id, s]));
  // v2: discover children of MY partial offers whose taker ALREADY COMMITTED real funds
  // (forward: their BTC confirmed; reverse: their FRC/asset locked) → local maker CHILD record.
  // Children reuse the OFFER's nonce — maker keys are offer-level; uniqueness comes from the taker's H.
  for (const off of mine.filter(r => r.partial && r.role === 'maker')) {
    for (const s of info.swaps) {
      const committed = off.dir === 'sellBtc' ? (s.status === 'frc_funded_rev' && !s.btcHtlc?.txid) : (s.status === 'btc_funded' && !s.frcHtlc?.txid);
      if (s.parent === off.id && committed && !mine.some(r => r.id === s.id))
        env.putP2p({ id: s.id, role: 'maker', dir: off.dir, parent: s.parent, nonce: off.nonce, status: 'taken', assetTag: s.assetTag ?? null, frcAmount: s.frcAmount, btcAmount: s.btcAmount, paymentHash: s.paymentHash });
    }
  }
  mine = env.loadP2p();   // pick up freshly added child records
  for (const rec of mine) {
    const w = byId.get(rec.id);
    if (!w) {
      // The relay no longer has this swap (settled, or dropped after a cancel). Drop the LOCAL record
      // ONLY when nothing is at stake — if my BTC HTLC or FRC leg is still funded and not yet
      // refunded, KEEP it so checkBtcRefunds / checkP2pRefunds can sweep it home at the timeout (they
      // drop it themselves once the refund lands). Dropping a funded, cancelled child here orphaned
      // the buyer's BTC (recoverable only via nonce-recovery).
      if ((rec.partial || rec.parent) && !rec.btcHtlc?.txid && !rec.funding?.txid) env.dropP2p(rec.id);
      continue;
    }
    try {
      if (w.v !== 2 && w.kind !== 'offer') {
        // legacy v1 swap: the v2 engine can't advance it — only the timeout/coop refund machinery
        // (checkP2pRefunds, driven from rec fields) still applies. A record with nothing funded is
        // dead weight from an old take — drop it so the board stops mislabeling it as in-progress.
        if (!rec.funding?.txid && !rec.btcHtlc?.txid) env.dropP2p(rec.id);
        continue;
      }
      if (rec.dir === 'sellBtc') { await driveP2pRev(rec, w, info); if (w.status === 'done') env.dropP2p(rec.id); continue; }
      if (rec.role === 'maker') {
        // buyer asked to cancel and I HAVEN'T locked → authorize the instant BTC refund (costs me
        // nothing; I never committed). SAFETY: refuse once I've locked — the buyer holds R and could
        // then reclaim BTC *and* claim my FRC. Relay enforces this too.
        if (w.cancelReq && !w.btcCoopSig && !w.frcHtlc?.txid && w.btcHtlc?.txid && w.btcHtlc.leaf) {
          const sig = btcHtlcCoopSig({ prevTxid: w.btcHtlc.txid, vout: w.btcHtlc.vout, valueSats: BigInt(w.btcHtlc.value), leafHex: w.btcHtlc.leaf, claimKey: p2pKey(rec.nonce, 'btc') });
          await api('p2pBtcCoopSign', { id: rec.id, makerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')), sig });
          env.toast(`${w.id}: ${tr('authorized the buyer’s cancel')}`, 'ok'); env.mvRefresh();
          continue;
        }
        if (w.status === 'btc_funded' && w.btcHtlc?.txid && !w.cancelReq && !w.btcCoopSig) {   // taker PAID → lock — UNLESS a coop cancel is in flight (never lock a cancelling swap)
          // don't lock on the relay's word alone: confirm the taker's BTC HTLC really holds the
          // promised sats at the leaf we'd claim (their H, my claim key, their refund key). A lie
          // here only wastes our lock (refundable), but verifying keeps us from funding a phantom.
          if (rec.status !== 'frc_funded') {
            // SECURITY: build the taker's BTC leaf with MY OWN derived claim key, never the
            // relay-echoed w.maker.btcPub — else a malicious relay substitutes its key on both
            // sides, the leaf still matches the funded output, I lock FRC, and it (not I) claims
            // the BTC with the revealed R. My later claim uses p2pKey(nonce,'btc'), so the leaf
            // MUST commit that key.
            const myBtcPub = pubkeyCompressed(p2pKey(rec.nonce, 'btc'));
            const bl = btcHtlcLeaf({ paymentHash: w.paymentHash, claimPub: myBtcPub, refundPub: w.taker.btcPub, cltv: w.btcHtlc.cltv });
            if (bl !== w.btcHtlc.leaf) throw new Error(tr('BTC HTLC mismatch'));
            await env.verifyBtcOutput({ txid: w.btcHtlc.txid, vout: w.btcHtlc.vout, spk: btcHtlcSpk(bl), minValue: w.btcAmount });
            // far(BTC) must outlast near(FRC) by a safety margin, in wall-clock, or the taker could
            // refund the far leg early AND claim my near leg. Check the RELAY-reported heights.
            const frcNear = info.v2?.frcNear || 60, farRemSec = Math.max(0, (w.btcHtlc.cltv - (info.btcHeight || 0))) * 600;
            const nearSec = frcNear * ((info.mineEveryMs || 20000) / 1000);
            if (farRemSec < nearSec * 2) throw new Error(tr('unsafe swap timelocks — try again'));
          }
          // IDEMPOTENT: if we already funded but the report never reached the relay (restart,
          // network), RE-REPORT the existing funding — never fund the same swap twice.
          if (rec.status === 'frc_funded' && rec.funding?.txid) {
            try {
              await api('p2pFrcFunded', { id: rec.id, txid: rec.funding.txid, vout: rec.funding.vout, t1: rec.T1 });
              env.toast(`${w.id}: ${tr('locked — the buyer claims it')}`, 'ok'); env.mvRefresh();
            } catch (e) {
              // PERMANENT rejection (e.g. a lock made by a stale pre-v2 client with per-child
              // keys): park that coin under a refund-only record — checkP2pRefunds sweeps it
              // home at its own T1 — and re-lock ONCE with the proper v2 offer-level keys.
              // A second rejection means a real bug: surface it, never lock a third coin.
              // ONLY a genuine spk/tag mismatch (a stale pre-v2 lock) heals. NB: the relay now sends
              // a DISTINCT "ещё не в блоке" for an unmined-but-valid funding — that must NOT match
              // here, or every mainnet sale would park its funding and re-lock a second coin.
              if (/не совпал/.test(e.message) && !rec.rehealed) {
                env.putP2p({ id: rec.id + ':stale', role: 'maker', status: 'frc_funded', assetTag: rec.assetTag ?? null,
                  nonce: rec.nonce, leaf: rec.leaf, T1: rec.T1, funding: rec.funding, frcAmount: rec.frcAmount, btcAmount: rec.btcAmount });
                const offNonce = rec.parent ? env.loadP2p().find(r => r.id === rec.parent)?.nonce : null;
                env.putP2p({ ...rec, status: 'taken', rehealed: true, funding: null, leaf: null, T1: null, ...(offNonce ? { nonce: offNonce } : {}) });
                env.toast(`${w.id}: ${tr('stale lock parked for refund — re-locking')}`, 'warn'); env.mvRefresh();
              } else throw e;
            }
            continue;
          }
          // NEAR timeout, anchored to the RELAY's height (+ drift buffer): the light client's tip
          // can lag and land "outside the window" at the relay.
          const T1 = Math.max(env.state().mine.height, info.frcHeight || 0) + (info.v2?.frcNear || 60);
          const leg = frcLeg({ role: 'give', ourKey: p2pKey(rec.nonce, 'frc'), theirPub: w.taker.frcPub, paymentHash: w.paymentHash, cltv: T1, net: env.swapNet() });
          // FRC HTLC (host coin) OR an asset HTLC (asset coin + separate FRC fee coin)
          const fund = w.assetTag ? await env.lockAssetToHtlc(leg.spk, w.assetTag, BigInt(w.frcAmount)) : await env.sendFrcToSpk(leg.spk, BigInt(w.frcAmount));
          env.putP2p({ ...rec, status: 'frc_funded', leaf: leg.leaf, T1, funding: { txid: fund.txid, vout: fund.vout, value: w.frcAmount, refheight: fund.refheight ?? env.state().mine.height } });
          await api('p2pFrcFunded', { id: rec.id, txid: fund.txid, vout: fund.vout, t1: T1 });
          env.toast(`${w.id}: ${tr('locked — the buyer claims it')}`, 'ok'); env.mvRefresh();
        } else if (w.status === 'frc_claimed' && w.preimage && w.btcHtlc?.txid) {   // buyer claimed (R public) → collect the BTC
          const b = w.btcHtlc;
          // claim straight into the in-wallet BTC ACCOUNT (not the per-nonce address) so proceeds
          // land in the visible balance — the claim auth key stays the offer-level swap key
          const cB = btcHtlcClaim({ prevTxid: b.txid, vout: b.vout, valueSats: BigInt(b.value), leafHex: b.leaf, preimage: w.preimage, claimKey: p2pKey(rec.nonce, 'btc'), toSpk: btcP2wpkhSpk(env.btcAcctPub()), fee: env.btcSpendFee() });
          await api('p2pBtcClaim', { id: rec.id, rawtx: cB.rawtx });
          env.addSwapHist({ id: rec.id, category: 'purchase', assetTag: rec.assetTag ?? w.assetTag ?? null, frcAmount: w.frcAmount, btcAmount: String(BigInt(b.value) - env.btcSpendFee()), btcTxid: cB.txid, frcTxid: rec.funding?.txid ?? null, time: Math.floor(Date.now() / 1000) });
          if (rec.parent) env.dropP2p(rec.id); else env.putP2p({ ...rec, status: 'done' });
          env.toast(`${w.id}: ${tr('BTC received ✅')}`, 'ok'); env.refreshBtc(); env.mvRefresh();
        }
      } else {   // taker (forward): I paid first; the seller locked → claim my FRC/asset (reveals R)
        if (w.status === 'frc_funded' && w.frcHtlc?.txid) {
          const R = p2pKey(rec.nonce, 'R'), f = w.frcHtlc, tag = w.assetTag ?? f.assetTag ?? null;
          // verify BEFORE revealing R: (1) the HTLC leaf is exactly (MY H, MY claim key, their
          // refund key, the reported cltv); (2) the funding OUTPUT really holds ≥ the promised
          // amount of the right asset — fetched + parsed locally, not taken on the relay's word.
          const expect = frcLeg({ role: 'receive', ourKey: p2pKey(rec.nonce, 'frc'), theirPub: w.maker.frcPub, paymentHash: rec.paymentHash, cltv: f.cltv, net: env.swapNet() });
          if (expect.leaf !== f.leaf) throw new Error(tr('FRC HTLC mismatch'));
          // minConf 1: never reveal R against an unconfirmed (possibly fabricated) FRC lock
          await env.verifyFrcOutput({ txid: f.txid, vout: f.vout, spk: expect.spk, minValue: w.frcAmount, assetTag: tag, minConf: 1 });
          let cF;
          if (tag) {   // asset HTLC → claim the asset's PRESENT VALUE, fee from a separate host coin
            const feeCoin = env.hostFeeCoin(env.state().mine.height, 11000n);
            if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
            const payout = assetPresentValue(BigInt(f.value), env.state().mine.height - f.refheight, env.rateOf(tag));
            cF = htlcClaimAsset({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leafHex: f.leaf, preimage: R, claimKey: p2pKey(rec.nonce, 'frc'), toSpk: env.spks()[0], assetTag: tag, payout, feeCoin, fee: 0n, lockHeight: env.state().mine.height });
          } else {
            cF = claimReceived({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leaf: f.leaf, preimage: R, ourKey: p2pKey(rec.nonce, 'frc'), toSpk: env.spks()[0], fee: 10000n });
          }
          await api('tx', { rawtx: cF.rawtx, kind: 'send' }); try { env.observe(cF.rawtx); } catch {}   // reflect it in the wallet's balance/activity now
          await api('p2pDone', { id: rec.id });
          env.addSwapHist({ id: rec.id, category: 'sale', assetTag: tag, frcAmount: w.frcAmount, btcAmount: w.btcAmount, btcTxid: null, btcFundTxid: rec.btcHtlc?.txid ?? null, frcTxid: cF.txid ?? null, time: Math.floor(Date.now() / 1000) });
          env.dropP2p(rec.id);
          env.toast(`${w.id}: ${tr(tag ? 'asset received ✅' : 'FRC received ✅')}`, 'ok'); env.mvRefresh();
        }
      }
      if (w.status === 'done') env.dropP2p(rec.id);
    } catch (e) {
      // surface the reason a swap won't advance (once per id per minute) instead of silently
      // retrying forever — this is how a stuck 'taken' offer stays stuck invisibly
      const key = rec.id + ':' + w.status;
      if (driveErr.get(key) !== e.message) { driveErr.set(key, e.message); env.toast(`${rec.id}: ${e.message}`, 'err'); }
    }
  }
}
const driveErr = new Map();   // last surfaced error per (id,status) — avoid toast spam

// REVERSE swap drive v2 (maker SELLS BTC): the TAKER locked FRC/asset first (far leg, at take);
// the maker responds with the BTC HTLC (near leg); the taker claims BTC (reveals R); the maker
// claims the FRC/asset with R. Anti-griefing mirror of the forward flow above.
async function driveP2pRev(rec, w, info) {
  const { tr, api, p2pKey } = env;
  if (rec.role === 'maker') {
    if (w.status === 'frc_funded_rev' && w.frcHtlc?.txid) {       // taker locked → lock BTC
      // SECURITY: don't fund real BTC on the relay's word. Independently verify the taker's FRC
      // FAR leg on-chain — rebuild its leaf with MY OWN claim key (the relay can't substitute it)
      // and confirm the funded output holds the promised amount/asset with ≥1 conf — mirroring the
      // forward maker. Skip once we've already funded (idempotent re-report below).
      if (rec.status !== 'btc_funded_rev') {
        const f = w.frcHtlc, tag = w.assetTag ?? f.assetTag ?? null;
        const expectFrc = frcLeg({ role: 'receive', ourKey: p2pKey(rec.nonce, 'frc'), theirPub: w.taker.frcPub, paymentHash: w.paymentHash, cltv: f.cltv, net: env.swapNet() });
        if (expectFrc.leaf !== f.leaf) throw new Error(tr('FRC HTLC mismatch'));
        await env.verifyFrcOutput({ txid: f.txid, vout: f.vout, spk: expectFrc.spk, minValue: w.frcAmount, assetTag: tag, minConf: 1 });
        // far(FRC) must outlast near(BTC) by a safety margin, in wall-clock.
        const btcNear = info.v2?.btcNear || 6, farRemSec = Math.max(0, (f.cltv - (info.frcHeight || 0))) * ((info.mineEveryMs || 20000) / 1000);
        if (farRemSec < btcNear * 600 * 2) throw new Error(tr('unsafe swap timelocks — try again'));
      }
      // IDEMPOTENT: already funded but the report didn't land (relay restart) → re-report, never
      // fund twice (this exact race once double-funded an HTLC).
      if (rec.status === 'btc_funded_rev' && rec.btcHtlc?.txid) {
        await api('p2pBtcFundedB', { id: rec.id, btcTxid: rec.btcHtlc.txid, tb: rec.btcHtlc.cltv });
        env.toast(`${w.id}: ${tr('BTC locked — the buyer claims it')}`, 'ok'); env.mvRefresh();
        return;
      }
      const tb = (info.btcHeight || 0) + (info.v2?.btcNear || 6);   // NEAR leg
      const bleaf = btcHtlcLeaf({ paymentHash: w.paymentHash, claimPub: w.taker.btcPub, refundPub: pubkeyCompressed(p2pKey(rec.nonce, 'btc')), cltv: tb });
      const baddr = btcHtlcAddress(bleaf, env.btcHrp());
      const fund = await env.btcFundHtlc(baddr, BigInt(w.btcAmount));
      env.putP2p({ ...rec, status: 'btc_funded_rev', btcHtlc: { addr: baddr, leaf: bleaf, cltv: tb, txid: fund.txid, vout: fund.vout, value: fund.value } });
      await api('p2pBtcFundedB', { id: rec.id, btcTxid: fund.txid, tb });
      env.toast(`${w.id}: ${tr('BTC locked — the buyer claims it')}`, 'ok'); env.mvRefresh();
    } else if (w.status === 'btc_claimed_rev' && w.preimage && w.frcHtlc?.txid) {   // R public → collect the FRC/asset
      const R = w.preimage, f = w.frcHtlc, tag = w.assetTag ?? f.assetTag ?? null;
      let cF;
      if (tag) {   // BUY asset: claim the asset's present value, fee from a host coin
        const feeCoin = env.hostFeeCoin(env.state().mine.height, 11000n);
        if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
        const payout = assetPresentValue(BigInt(f.value), env.state().mine.height - f.refheight, env.rateOf(tag));
        cF = htlcClaimAsset({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leafHex: f.leaf, preimage: R, claimKey: p2pKey(rec.nonce, 'frc'), toSpk: env.spks()[0], assetTag: tag, payout, feeCoin, fee: 0n, lockHeight: env.state().mine.height });
      } else {
        cF = claimReceived({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leaf: f.leaf, preimage: R, ourKey: p2pKey(rec.nonce, 'frc'), toSpk: env.spks()[0], fee: 10000n });
      }
      await api('tx', { rawtx: cF.rawtx, kind: 'send' }); try { env.observe(cF.rawtx); } catch {}   // reflect it in the wallet's balance/activity now
      env.addSwapHist({ id: rec.id, category: 'purchase', assetTag: tag, frcAmount: w.frcAmount, btcAmount: w.btcAmount, btcTxid: null, btcFundTxid: rec.btcHtlc?.txid ?? null, frcTxid: cF.txid ?? null, time: Math.floor(Date.now() / 1000) });
      if (rec.parent) env.dropP2p(rec.id); else env.putP2p({ ...rec, status: 'done' });
      env.toast(`${w.id}: ${tr(tag ? 'asset received ✅' : 'FRC received ✅')}`, 'ok'); env.mvRefresh();
    }
  } else {   // taker: I locked at take; the seller's BTC is up → claim it (reveals R)
    if (w.status === 'frc_funded_rev' && rec.status === 'frc_funded_rev' && rec.funding?.txid && !w.frcHtlc?.txid) {
      // IDEMPOTENT: funded at take but the report never landed — re-report the existing funding
      await api('p2pFrcFundedB', { id: rec.id, txid: rec.funding.txid, vout: rec.funding.vout ?? 0 });
      env.toast(`${w.id}: ${tr('locked — the seller sends BTC, it arrives automatically')}`, 'ok'); env.mvRefresh();
    } else if (w.status === 'btc_funded_rev' && w.btcHtlc?.txid) {
      const R = p2pKey(rec.nonce, 'R'), b = w.btcHtlc;
      // verify BEFORE revealing R: (1) the BTC leaf is exactly (MY H, MY claim key, their refund
      // key, the reported cltv); (2) the funding output really holds ≥ the promised sats — fetched
      // and parsed locally, not on the relay's word.
      const expect = btcHtlcLeaf({ paymentHash: rec.paymentHash, claimPub: pubkeyCompressed(p2pKey(rec.nonce, 'btc')), refundPub: w.maker.btcPub, cltv: b.cltv });
      if (expect !== b.leaf) throw new Error(tr('BTC HTLC mismatch'));
      // minConf 1: never reveal R against an unconfirmed (possibly fabricated) BTC lock
      await env.verifyBtcOutput({ txid: b.txid, vout: b.vout, spk: btcHtlcSpk(b.leaf), minValue: w.btcAmount, minConf: 1 });
      const cB = btcHtlcClaim({ prevTxid: b.txid, vout: b.vout, valueSats: BigInt(b.value), leafHex: b.leaf, preimage: R, claimKey: p2pKey(rec.nonce, 'btc'), toSpk: btcP2wpkhSpk(env.btcAcctPub()), fee: env.btcSpendFee() });
      await api('p2pBtcClaimB', { id: rec.id, rawtx: cB.rawtx });
      env.addSwapHist({ id: rec.id, category: 'sale', assetTag: rec.assetTag ?? w.assetTag ?? null, frcAmount: w.frcAmount, btcAmount: String(BigInt(b.value) - env.btcSpendFee()), btcTxid: cB.txid, frcTxid: rec.funding?.txid ?? null, time: Math.floor(Date.now() / 1000) });
      env.dropP2p(rec.id);
      env.toast(`${w.id}: ${tr('BTC received ✅')}`, 'ok'); env.refreshBtc(); env.mvRefresh();
    }
  }
}
