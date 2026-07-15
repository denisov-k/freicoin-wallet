// mv-swap-drive.mjs — the P2P swap ENGINE: advance each of MY swaps on every refresh (fund/claim on
// my turn, both directions + partial children), and auto-refund a locked leg once its timelock passes
// (FRC/asset via checkP2pRefunds, my BTC via checkBtcRefunds). Extracted verbatim from market-view;
// reads the live session through `ctx`, and gets toast/mvRefresh injected (UI touchpoints) to avoid a cycle.
import { ctx, api, p2pKey, rateOf, swapNet, btcFeeFor, VB_HTLC_SPEND } from './mv-ctx.mjs';
import { loadP2p, putP2p, dropP2p, addSwapHist, addRefundedFund } from './mv-storage.mjs';
import { hostFeeCoin, sendFrcToSpk, lockAssetToHtlc } from './mv-swap-lib.mjs';
import { btcFundHtlc, btcAcctPub, btcHrp, refreshBtc } from './mv-btc-account.mjs';
import { htlcClaimAsset, htlcRefundAsset, htlcSpk, htlcCoopRefundHost, htlcCoopRefundAsset } from '../../../core/htlc.mjs';
import { frcLeg, refundGiven, claimReceived } from '../../../core/swap.mjs';
import { btcHtlcClaim, btcHtlcRefund, btcHtlcLeaf, btcHtlcAddress, btcHtlcSpk, btcHtlcCoopSig, btcHtlcCoopRefund, btcP2wpkhSpk } from '../../../core/btc.mjs';
import { verifyFrcOutput, verifyBtcOutput } from './mv-verify.mjs';
import { assetPresentValue } from '../../../core/assets.mjs';
import { pubkeyCompressed } from '../../../core/ecdsa.mjs';
import { sha256 } from '../../../core/crypto.mjs';
import { tr } from './i18n.mjs';

// BTC HTLC claim/refund fee: the tx's vsize is constant (~170 vB), so the fee tracks the LIVE
// feerate the relay estimates — a claim that misses its timelock because it was under-priced is
// how an atomic swap actually loses money.
const btcSpendFee = () => btcFeeFor(VB_HTLC_SPEND);

/** @type {(m: string, cls?: string) => void} */
let toast = () => {};
/** @type {() => void} */
let mvRefresh = () => {};
export function initDrive(deps) { ({ toast, mvRefresh } = deps); }

// AUTO-REFUND (FRC/asset leg): a leg I locked (forward maker: frc_funded; reverse taker: frc_funded_rev)
// that never completed comes back to me once its CLTV passes — a plain HTLC refund can't be instant (the
// timelock IS the atomic-swap safety), but the funds must not sit locked forever either.
export async function checkP2pRefunds() {
  const h = ctx.state.mine.height;
  for (const rec of loadP2p()) {
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
        if (!w || ['done', 'cancelled', 'expired'].includes(w.status)) dropP2p(rec.id);
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
            const feeCoin = hostFeeCoin(refh, 11000n);   // must be OLDER than the HTLC (valued at refh)
            if (!feeCoin) throw new Error(tr('you need an older FRC coin (tap Faucet) for the network fee'));
            cr = htlcCoopRefundAsset({ funding: { txid: funding.txid, vout: funding.vout, value: BigInt(live.value), refheight: refh }, leafHex: leaf, refundKey: ourKey, otherSig: w.coopSig, toSpk: ctx.spks[0], assetTag: tag, feeCoin, fee: 10000n });
          } else {
            cr = htlcCoopRefundHost({ funding: { txid: funding.txid, vout: funding.vout, value: BigInt(live.value), refheight: refh }, leafHex: leaf, refundKey: ourKey, otherSig: w.coopSig, toSpk: ctx.spks[0], fee: 10000n });
          }
          await api('tx', { rawtx: cr.rawtx, kind: 'send' });
          dropP2p(rec.id);
          toast(`${rec.id}: ${tr(tag ? 'asset refunded (cancelled)' : 'FRC refunded (cancelled)')}`, 'ok'); mvRefresh();
          continue;
        } catch { /* invalid/foreign coopSig — ignore it and let the timeout refund below run */ }
      }
      if (h <= cltv + 1) continue;                          // CLTV not reached yet — nothing to do
      let rf;
      if (tag) {   // asset refund: whole asset back to me (present-valued), fee from a host coin
        const feeCoin = hostFeeCoin(h, 11000n);
        if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
        const payout = assetPresentValue(BigInt(live.value), h - Number(funding.refheight), rateOf(tag));
        rf = htlcRefundAsset({ funding: { txid: funding.txid, vout: funding.vout, value: BigInt(live.value), refheight: Number(funding.refheight) }, leafHex: leaf, cltv, refundKey: ourKey, toSpk: ctx.spks[0], assetTag: tag, payout, feeCoin, fee: 10000n, lockHeight: h });
      } else {
        rf = refundGiven({ funding: { txid: funding.txid, vout: funding.vout, value: BigInt(live.value), refheight: Number(funding.refheight) }, leaf, cltv, ourKey, toSpk: ctx.spks[0], fee: 10000n });
      }
      await api('tx', { rawtx: rf.rawtx, kind: 'send' });
      dropP2p(rec.id);
      toast(`${rec.id}: ${tr(tag ? 'asset refunded' : 'FRC refunded')}`, 'ok'); mvRefresh();
    } catch (e) { /* too early, coin gone, or missing fee coin — retry next cycle */ }
  }
}

// AUTO-REFUND (BTC leg): whoever funded a BTC HTLC that never completed sweeps it home once its
// CLTV passes — the forward BUYER (far leg, seller never locked/claimed) and the v2 reverse MAKER
// (near leg, taker never claimed). Nobody has to babysit the tab for the money to come home.
export async function checkBtcRefunds() {
  if (!ctx.state?.swap?.available) return;
  const mine = loadP2p().filter(r => ((r.role === 'taker' && r.dir !== 'sellBtc') || (r.role === 'maker' && r.dir === 'sellBtc'))
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
        refundKey: p2pKey(rec.nonce, 'btc'), otherSig: w.btcCoopSig, toSpk: btcP2wpkhSpk(btcAcctPub()), fee: btcSpendFee() });
      await api('btcBroadcast', { rawtx: cr.rawtx });
      addRefundedFund(b.txid);
      await api('p2pBtcCancelled', { id: rec.id, takerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) }).catch(() => {});
      dropP2p(rec.id);
      toast(`${rec.id}: ${tr('purchase cancelled — BTC returned')}`, 'ok'); refreshBtc(); mvRefresh();
    } catch { /* seller not yet signed, or already swept — retry */ }
  }
  for (const rec of mine) {
    try {
      const b = rec.btcHtlc, w = byId.get(rec.id);
      if (w?.preimage) continue;          // R revealed → the seller took the BTC; I claim FRC instead (driveP2p)
      if (bh <= b.cltv) continue;         // T2 not reached yet — the swap can still complete normally
      const rf = btcHtlcRefund({ prevTxid: b.txid, vout: b.vout ?? 0, valueSats: BigInt(b.value), leafHex: b.leaf, cltv: b.cltv, refundKey: p2pKey(rec.nonce, 'btc'), toSpk: btcP2wpkhSpk(btcAcctPub()), fee: btcSpendFee() });
      await api('btcBroadcast', { rawtx: rf.rawtx });
      addRefundedFund(b.txid);            // this swap round-tripped (out then back) — un-hide the funding send so the ledger explains the fee
      dropP2p(rec.id);
      toast(`${rec.id}: ${tr('BTC refunded (seller offline)')}`, 'ok'); refreshBtc(); mvRefresh();
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
  let mine = loadP2p(); if (!ctx.state) return;
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
        putP2p({ id: s.id, role: 'maker', dir: off.dir, parent: s.parent, nonce: off.nonce, status: 'taken', assetTag: s.assetTag ?? null, frcAmount: s.frcAmount, btcAmount: s.btcAmount, paymentHash: s.paymentHash });
    }
  }
  mine = loadP2p();   // pick up freshly added child records
  for (const rec of mine) {
    const w = byId.get(rec.id); if (!w) { if (rec.partial || rec.parent) dropP2p(rec.id); continue; }   // offer/child gone from relay ⇒ settled
    try {
      if (w.v !== 2 && w.kind !== 'offer') {
        // legacy v1 swap: the v2 engine can't advance it — only the timeout/coop refund machinery
        // (checkP2pRefunds, driven from rec fields) still applies. A record with nothing funded is
        // dead weight from an old take — drop it so the board stops mislabeling it as in-progress.
        if (!rec.funding?.txid && !rec.btcHtlc?.txid) dropP2p(rec.id);
        continue;
      }
      if (rec.dir === 'sellBtc') { await driveP2pRev(rec, w, info); if (w.status === 'done') dropP2p(rec.id); continue; }
      if (rec.role === 'maker') {
        // buyer asked to cancel and I HAVEN'T locked → authorize the instant BTC refund (costs me
        // nothing; I never committed). SAFETY: refuse once I've locked — the buyer holds R and could
        // then reclaim BTC *and* claim my FRC. Relay enforces this too.
        if (w.cancelReq && !w.btcCoopSig && !w.frcHtlc?.txid && w.btcHtlc?.txid && w.btcHtlc.leaf) {
          const sig = btcHtlcCoopSig({ prevTxid: w.btcHtlc.txid, vout: w.btcHtlc.vout, valueSats: BigInt(w.btcHtlc.value), leafHex: w.btcHtlc.leaf, claimKey: p2pKey(rec.nonce, 'btc') });
          await api('p2pBtcCoopSign', { id: rec.id, makerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')), sig });
          toast(`${w.id}: ${tr('authorized the buyer’s cancel')}`, 'ok'); mvRefresh();
          continue;
        }
        if (w.status === 'btc_funded' && w.btcHtlc?.txid && !w.cancelReq && !w.btcCoopSig) {   // taker PAID → lock — UNLESS a coop cancel is in flight (never lock a cancelling swap)
          // don't lock on the relay's word alone: confirm the taker's BTC HTLC really holds the
          // promised sats at the leaf we'd claim (their H, my claim key, their refund key). A lie
          // here only wastes our lock (refundable), but verifying keeps us from funding a phantom.
          if (rec.status !== 'frc_funded') {
            const bl = btcHtlcLeaf({ paymentHash: w.paymentHash, claimPub: w.maker.btcPub, refundPub: w.taker.btcPub, cltv: w.btcHtlc.cltv });
            if (bl !== w.btcHtlc.leaf) throw new Error(tr('BTC HTLC mismatch'));
            await verifyBtcOutput({ txid: w.btcHtlc.txid, vout: w.btcHtlc.vout, spk: btcHtlcSpk(bl), minValue: w.btcAmount });
          }
          // IDEMPOTENT: if we already funded but the report never reached the relay (restart,
          // network), RE-REPORT the existing funding — never fund the same swap twice.
          if (rec.status === 'frc_funded' && rec.funding?.txid) {
            try {
              await api('p2pFrcFunded', { id: rec.id, txid: rec.funding.txid, vout: rec.funding.vout, t1: rec.T1 });
              toast(`${w.id}: ${tr('locked — the buyer claims it')}`, 'ok'); mvRefresh();
            } catch (e) {
              // PERMANENT rejection (e.g. a lock made by a stale pre-v2 client with per-child
              // keys): park that coin under a refund-only record — checkP2pRefunds sweeps it
              // home at its own T1 — and re-lock ONCE with the proper v2 offer-level keys.
              // A second rejection means a real bug: surface it, never lock a third coin.
              // ONLY a genuine spk/tag mismatch (a stale pre-v2 lock) heals. NB: the relay now sends
              // a DISTINCT "ещё не в блоке" for an unmined-but-valid funding — that must NOT match
              // here, or every mainnet sale would park its funding and re-lock a second coin.
              if (/не совпал/.test(e.message) && !rec.rehealed) {
                putP2p({ id: rec.id + ':stale', role: 'maker', status: 'frc_funded', assetTag: rec.assetTag ?? null,
                  nonce: rec.nonce, leaf: rec.leaf, T1: rec.T1, funding: rec.funding, frcAmount: rec.frcAmount, btcAmount: rec.btcAmount });
                const offNonce = rec.parent ? loadP2p().find(r => r.id === rec.parent)?.nonce : null;
                putP2p({ ...rec, status: 'taken', rehealed: true, funding: null, leaf: null, T1: null, ...(offNonce ? { nonce: offNonce } : {}) });
                toast(`${w.id}: ${tr('stale lock parked for refund — re-locking')}`, 'warn'); mvRefresh();
              } else throw e;
            }
            continue;
          }
          // NEAR timeout, anchored to the RELAY's height (+ drift buffer): the light client's tip
          // can lag and land "outside the window" at the relay.
          const T1 = Math.max(ctx.state.mine.height, info.frcHeight || 0) + (info.v2?.frcNear || 60);
          const leg = frcLeg({ role: 'give', ourKey: p2pKey(rec.nonce, 'frc'), theirPub: w.taker.frcPub, paymentHash: w.paymentHash, cltv: T1, net: swapNet() });
          // FRC HTLC (host coin) OR an asset HTLC (asset coin + separate FRC fee coin)
          const fund = w.assetTag ? await lockAssetToHtlc(leg.spk, w.assetTag, BigInt(w.frcAmount)) : await sendFrcToSpk(leg.spk, BigInt(w.frcAmount));
          putP2p({ ...rec, status: 'frc_funded', leaf: leg.leaf, T1, funding: { txid: fund.txid, vout: fund.vout, value: w.frcAmount, refheight: fund.refheight ?? ctx.state.mine.height } });
          await api('p2pFrcFunded', { id: rec.id, txid: fund.txid, vout: fund.vout, t1: T1 });
          toast(`${w.id}: ${tr('locked — the buyer claims it')}`, 'ok'); mvRefresh();
        } else if (w.status === 'frc_claimed' && w.preimage && w.btcHtlc?.txid) {   // buyer claimed (R public) → collect the BTC
          const b = w.btcHtlc;
          // claim straight into the in-wallet BTC ACCOUNT (not the per-nonce address) so proceeds
          // land in the visible balance — the claim auth key stays the offer-level swap key
          const cB = btcHtlcClaim({ prevTxid: b.txid, vout: b.vout, valueSats: BigInt(b.value), leafHex: b.leaf, preimage: w.preimage, claimKey: p2pKey(rec.nonce, 'btc'), toSpk: btcP2wpkhSpk(btcAcctPub()), fee: btcSpendFee() });
          await api('p2pBtcClaim', { id: rec.id, rawtx: cB.rawtx });
          addSwapHist({ id: rec.id, category: 'purchase', assetTag: rec.assetTag ?? w.assetTag ?? null, frcAmount: w.frcAmount, btcAmount: String(BigInt(b.value) - btcSpendFee()), btcTxid: cB.txid, frcTxid: rec.funding?.txid ?? null, time: Math.floor(Date.now() / 1000) });
          if (rec.parent) dropP2p(rec.id); else putP2p({ ...rec, status: 'done' });
          toast(`${w.id}: ${tr('BTC received ✅')}`, 'ok'); refreshBtc(); mvRefresh();
        }
      } else {   // taker (forward): I paid first; the seller locked → claim my FRC/asset (reveals R)
        if (w.status === 'frc_funded' && w.frcHtlc?.txid) {
          const R = p2pKey(rec.nonce, 'R'), f = w.frcHtlc, tag = w.assetTag ?? f.assetTag ?? null;
          // verify BEFORE revealing R: (1) the HTLC leaf is exactly (MY H, MY claim key, their
          // refund key, the reported cltv); (2) the funding OUTPUT really holds ≥ the promised
          // amount of the right asset — fetched + parsed locally, not taken on the relay's word.
          const expect = frcLeg({ role: 'receive', ourKey: p2pKey(rec.nonce, 'frc'), theirPub: w.maker.frcPub, paymentHash: rec.paymentHash, cltv: f.cltv, net: swapNet() });
          if (expect.leaf !== f.leaf) throw new Error(tr('FRC HTLC mismatch'));
          // minConf 1: never reveal R against an unconfirmed (possibly fabricated) FRC lock
          await verifyFrcOutput({ txid: f.txid, vout: f.vout, spk: expect.spk, minValue: w.frcAmount, assetTag: tag, minConf: 1 });
          let cF;
          if (tag) {   // asset HTLC → claim the asset's PRESENT VALUE, fee from a separate host coin
            const feeCoin = hostFeeCoin(ctx.state.mine.height, 11000n);
            if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
            const payout = assetPresentValue(BigInt(f.value), ctx.state.mine.height - f.refheight, rateOf(tag));
            cF = htlcClaimAsset({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leafHex: f.leaf, preimage: R, claimKey: p2pKey(rec.nonce, 'frc'), toSpk: ctx.spks[0], assetTag: tag, payout, feeCoin, fee: 10000n, lockHeight: ctx.state.mine.height });
          } else {
            cF = claimReceived({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leaf: f.leaf, preimage: R, ourKey: p2pKey(rec.nonce, 'frc'), toSpk: ctx.spks[0], fee: 10000n });
          }
          await api('tx', { rawtx: cF.rawtx, kind: 'send' });
          await api('p2pDone', { id: rec.id });
          addSwapHist({ id: rec.id, category: 'sale', assetTag: tag, frcAmount: w.frcAmount, btcAmount: w.btcAmount, btcTxid: null, btcFundTxid: rec.btcHtlc?.txid ?? null, frcTxid: cF.txid ?? null, time: Math.floor(Date.now() / 1000) });
          dropP2p(rec.id);
          toast(`${w.id}: ${tr(tag ? 'asset received ✅' : 'FRC received ✅')}`, 'ok'); mvRefresh();
        }
      }
      if (w.status === 'done') dropP2p(rec.id);
    } catch (e) {
      // surface the reason a swap won't advance (once per id per minute) instead of silently
      // retrying forever — this is how a stuck 'taken' offer stays stuck invisibly
      const key = rec.id + ':' + w.status;
      if (driveErr.get(key) !== e.message) { driveErr.set(key, e.message); toast(`${rec.id}: ${e.message}`, 'err'); }
    }
  }
}
const driveErr = new Map();   // last surfaced error per (id,status) — avoid toast spam

// REVERSE swap drive v2 (maker SELLS BTC): the TAKER locked FRC/asset first (far leg, at take);
// the maker responds with the BTC HTLC (near leg); the taker claims BTC (reveals R); the maker
// claims the FRC/asset with R. Anti-griefing mirror of the forward flow above.
async function driveP2pRev(rec, w, info) {
  if (rec.role === 'maker') {
    if (w.status === 'frc_funded_rev' && w.frcHtlc?.txid) {       // taker locked (relay verified) → lock BTC
      // IDEMPOTENT: already funded but the report didn't land (relay restart) → re-report, never
      // fund twice (this exact race once double-funded an HTLC).
      if (rec.status === 'btc_funded_rev' && rec.btcHtlc?.txid) {
        await api('p2pBtcFundedB', { id: rec.id, btcTxid: rec.btcHtlc.txid, tb: rec.btcHtlc.cltv });
        toast(`${w.id}: ${tr('BTC locked — the buyer claims it')}`, 'ok'); mvRefresh();
        return;
      }
      const tb = (info.btcHeight || 0) + (info.v2?.btcNear || 6);   // NEAR leg
      const bleaf = btcHtlcLeaf({ paymentHash: w.paymentHash, claimPub: w.taker.btcPub, refundPub: pubkeyCompressed(p2pKey(rec.nonce, 'btc')), cltv: tb });
      const baddr = btcHtlcAddress(bleaf, btcHrp());
      const fund = await btcFundHtlc(baddr, BigInt(w.btcAmount));
      putP2p({ ...rec, status: 'btc_funded_rev', btcHtlc: { addr: baddr, leaf: bleaf, cltv: tb, txid: fund.txid, vout: fund.vout, value: fund.value } });
      await api('p2pBtcFundedB', { id: rec.id, btcTxid: fund.txid, tb });
      toast(`${w.id}: ${tr('BTC locked — the buyer claims it')}`, 'ok'); mvRefresh();
    } else if (w.status === 'btc_claimed_rev' && w.preimage && w.frcHtlc?.txid) {   // R public → collect the FRC/asset
      const R = w.preimage, f = w.frcHtlc, tag = w.assetTag ?? f.assetTag ?? null;
      let cF;
      if (tag) {   // BUY asset: claim the asset's present value, fee from a host coin
        const feeCoin = hostFeeCoin(ctx.state.mine.height, 11000n);
        if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
        const payout = assetPresentValue(BigInt(f.value), ctx.state.mine.height - f.refheight, rateOf(tag));
        cF = htlcClaimAsset({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leafHex: f.leaf, preimage: R, claimKey: p2pKey(rec.nonce, 'frc'), toSpk: ctx.spks[0], assetTag: tag, payout, feeCoin, fee: 10000n, lockHeight: ctx.state.mine.height });
      } else {
        cF = claimReceived({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight }, leaf: f.leaf, preimage: R, ourKey: p2pKey(rec.nonce, 'frc'), toSpk: ctx.spks[0], fee: 10000n });
      }
      await api('tx', { rawtx: cF.rawtx, kind: 'send' });
      addSwapHist({ id: rec.id, category: 'purchase', assetTag: tag, frcAmount: w.frcAmount, btcAmount: w.btcAmount, btcTxid: null, btcFundTxid: rec.btcHtlc?.txid ?? null, frcTxid: cF.txid ?? null, time: Math.floor(Date.now() / 1000) });
      if (rec.parent) dropP2p(rec.id); else putP2p({ ...rec, status: 'done' });
      toast(`${w.id}: ${tr(tag ? 'asset received ✅' : 'FRC received ✅')}`, 'ok'); mvRefresh();
    }
  } else {   // taker: I locked at take; the seller's BTC is up → claim it (reveals R)
    if (w.status === 'frc_funded_rev' && rec.status === 'frc_funded_rev' && rec.funding?.txid && !w.frcHtlc?.txid) {
      // IDEMPOTENT: funded at take but the report never landed — re-report the existing funding
      await api('p2pFrcFundedB', { id: rec.id, txid: rec.funding.txid, vout: rec.funding.vout ?? 0 });
      toast(`${w.id}: ${tr('locked — the seller sends BTC, it arrives automatically')}`, 'ok'); mvRefresh();
    } else if (w.status === 'btc_funded_rev' && w.btcHtlc?.txid) {
      const R = p2pKey(rec.nonce, 'R'), b = w.btcHtlc;
      // verify BEFORE revealing R: (1) the BTC leaf is exactly (MY H, MY claim key, their refund
      // key, the reported cltv); (2) the funding output really holds ≥ the promised sats — fetched
      // and parsed locally, not on the relay's word.
      const expect = btcHtlcLeaf({ paymentHash: rec.paymentHash, claimPub: pubkeyCompressed(p2pKey(rec.nonce, 'btc')), refundPub: w.maker.btcPub, cltv: b.cltv });
      if (expect !== b.leaf) throw new Error(tr('BTC HTLC mismatch'));
      // minConf 1: never reveal R against an unconfirmed (possibly fabricated) BTC lock
      await verifyBtcOutput({ txid: b.txid, vout: b.vout, spk: btcHtlcSpk(b.leaf), minValue: w.btcAmount, minConf: 1 });
      const cB = btcHtlcClaim({ prevTxid: b.txid, vout: b.vout, valueSats: BigInt(b.value), leafHex: b.leaf, preimage: R, claimKey: p2pKey(rec.nonce, 'btc'), toSpk: btcP2wpkhSpk(btcAcctPub()), fee: btcSpendFee() });
      await api('p2pBtcClaimB', { id: rec.id, rawtx: cB.rawtx });
      addSwapHist({ id: rec.id, category: 'sale', assetTag: rec.assetTag ?? w.assetTag ?? null, frcAmount: w.frcAmount, btcAmount: String(BigInt(b.value) - btcSpendFee()), btcTxid: cB.txid, frcTxid: rec.funding?.txid ?? null, time: Math.floor(Date.now() / 1000) });
      dropP2p(rec.id);
      toast(`${w.id}: ${tr('BTC received ✅')}`, 'ok'); refreshBtc(); mvRefresh();
    }
  }
}
