// mv-activity.mjs — the Activity feed's cross-chain view: recover past-swap BTC addresses/history from
// the relay, and build TRADE rows (both legs) for the wallet's one activity list. Extracted verbatim
// from market-view.mjs; reads the live session through `ctx`. doRefresh is injected (initActivity) to
// avoid an import cycle with market-view's refresh orchestrator.
import { ctx, api, p2pKey, scaleOf, assetName } from './mv-ctx.mjs';
import { loadBtcNonces, addBtcNonce, loadP2p, putP2p, addSwapHist, loadSwapHist, pruneSwapHist,
  addFundTxid, loadFundTxids, loadRefundedFunds } from './mv-storage.mjs';
import { btcAcctAddr, btcKeyring, btcHrp } from './mv-btc-account.mjs';
import { claimReceived } from '../../../core/swap.mjs';
import { btcP2wpkhAddress } from '../../../core/btc.mjs';
import { pubkeyCompressed } from '../../../core/ecdsa.mjs';
import { sha256 } from '../../../core/crypto.mjs';

let refresh = null;   // market-view's doRefresh, injected (first-load bootstrap for mvBtcHistory)
export function initActivity(doRefresh) { refresh = doRefresh; }

// Recover BTC addresses of PAST swaps whose local record was already dropped: match each live relay
// offer against my derivable keys — the taker nonce is deterministic (from the offer id); the maker
// nonce brute-forces the post height. Found nonces go into the address book. One-time per session.
let btcRecoveredKey = '';
export function resetRecovery() { btcRecoveredKey = ''; }   // force recovery to re-run (e.g. on a chain switch)
export async function recoverBtcNonces() {
  const offers = [...(ctx.state?.p2p?.swaps || []), ...(ctx.state?.p2p?.archive || [])];   // live board + completed archive
  // re-run whenever the offer set (or its statuses/known fundings) changes — a one-shot flag left
  // stale synthesis in place when the archive was corrected under a long-lived tab
  const key = offers.map(o => `${o.id}:${o.status}:${(o.btcHtlc || {}).txid || ''}:${o.frcSpendTxid || ''}`).join(',');
  if (!offers.length || key === btcRecoveredKey) return;
  btcRecoveredKey = key;
  const tip = ctx.state.mine.height, known = new Set(loadBtcNonces());
  // A completed swap whose local record is gone still deserves a trade row — synthesize the
  // history entry from the relay offer once we prove the role (keys match). Idempotent (by id).
  const doneish = o => ['btc_claimed', 'frc_claimed_rev', 'frc_claimed', 'btc_claimed_rev', 'done'].includes(o.status);
  const synth = (o, role, nonce) => {
    if (!doneish(o)) return;
    const boughtBtc = (role === 'maker') !== (o.dir === 'sellBtc');   // forward maker & reverse taker BUY btc
    // The FRC leg's txid the trade row must hide: the side that FUNDED the FRC/asset HTLC (forward
    // maker / reverse taker) hides the funding tx (on the offer); the side that CLAIMED it hides the
    // claim tx — the relay records its txid off the chain (frcSpendTxid); a host-FRC claim can also
    // be rebuilt deterministically (RFC6979) as a fallback for pre-frcSpendTxid archive entries.
    // (An ASSET claim is NOT rebuildable: its fee coin was picked from the then-current utxo set.)
    const fundsFrc = (role === 'maker') === (o.dir !== 'sellBtc');
    let frcTxid = fundsFrc ? (o.frcHtlc?.txid ?? null) : (o.frcSpendTxid ?? null);
    if (!fundsFrc && !frcTxid && o.preimage && o.frcHtlc?.txid != null && !o.assetTag) {
      try { frcTxid = claimReceived({ funding: { txid: o.frcHtlc.txid, vout: o.frcHtlc.vout, value: BigInt(o.frcHtlc.value), refheight: o.frcHtlc.refheight },
        leaf: o.frcHtlc.leaf, preimage: o.preimage, ourKey: p2pKey(nonce, 'frc'), toSpk: ctx.spks[0], fee: 10000n }).txid; } catch {}
    }
    // ASSET claimer with no claim txid yet: DON'T synthesize the trade row — its raw asset-receive
    // leg can't be hidden without that txid, so rendering now would double-count the asset (once in
    // the trade row, once as a standalone receive). The relay stamps frcSpendTxid within a block or
    // two; the row appears correctly on the next refresh. (Host-FRC has the RFC6979 fallback above.)
    if (!fundsFrc && o.assetTag && !frcTxid) return;
    addSwapHist({ id: o.id, category: boughtBtc ? 'purchase' : 'sale', assetTag: o.assetTag ?? null, frcAmount: o.frcAmount, btcAmount: o.btcHtlc?.value || o.btcAmount,
      btcTxid: null, btcFundTxid: boughtBtc ? null : (o.btcHtlc?.txid ?? null),   // the maker's HTLC-funding spend, covered by the trade row
      btcAddr: boughtBtc ? btcP2wpkhAddress(pubkeyCompressed(p2pKey(nonce, 'btc')), btcHrp()) : null,
      // the relay stamps completed swaps (archivedAt): without SOME time a synthesized row whose
      // BTC receive fails to match is dropped as a phantom instead of rendering as a trade
      frcTxid, time: o.archivedAt ? Math.floor(o.archivedAt / 1000) : 0 });
  };
  const nonceOf = s => sha256(Buffer.from(ctx.seed + s, 'utf8')).toString('hex').slice(0, 16);
  // RESURRECT a LIVE record whose localStorage copy was dropped: a lost record DETACHES the
  // offer/swap from the account — the board stops showing it as mine, the drive stops funding
  // child fills / claiming payouts. Key ownership is already proven here; the relay's status is
  // authoritative for what happens next (it says 'taken' only while nothing was funded, so a
  // resurrected maker record can't double-fund).
  const resurrect = (o, role, n) => {
    if (['done', 'cancelled', 'expired'].includes(o.status)) return;
    // v2: frc_claimed / btc_claimed_rev mean the TAKER's funds are already claimed — only the
    // MAKER still has something to collect there; a resurrected taker record would just haunt
    // the board as an eternal "swap complete ✅" row.
    if (role === 'taker' && ['frc_claimed', 'btc_claimed_rev'].includes(o.status)) return;
    // WHOEVER LOCKED A COIN must carry its HTLC material so the refund machinery can sweep it home
    // if the swap stalls — else a lost record strands the coin past its timelock. Two funders:
    //   • FRC-side funder (forward maker / reverse taker) → rec.leaf + rec.funding (checkP2pRefunds)
    //   • BTC-side funder (forward taker paid / reverse maker locked) → rec.btcHtlc (checkBtcRefunds)
    const fundsFrc = (role === 'maker') === (o.dir !== 'sellBtc');
    const frcHtlc = fundsFrc && ['frc_funded', 'frc_funded_rev'].includes(o.status) && o.frcHtlc?.txid != null
      ? { status: o.status, leaf: o.frcHtlc.leaf, T1: o.frcHtlc.cltv ?? o.t1,
          funding: { txid: o.frcHtlc.txid, vout: o.frcHtlc.vout ?? 0, value: o.frcHtlc.value, refheight: o.frcHtlc.refheight } }
      : {};
    // BTC funder: forward TAKER once their payment is on-chain (status btc_funded), reverse MAKER
    // once they've locked (btc_funded_rev). Both need the full btcHtlc {txid,vout,value,leaf,cltv}.
    const fundsBtc = (role === 'taker' && o.dir !== 'sellBtc') || (role === 'maker' && o.dir === 'sellBtc');
    const btcRestore = fundsBtc && o.btcHtlc?.txid && o.btcHtlc.leaf && o.btcHtlc.cltv != null
      ? { btcHtlc: { txid: o.btcHtlc.txid, vout: o.btcHtlc.vout ?? 0, value: o.btcHtlc.value, leaf: o.btcHtlc.leaf, cltv: o.btcHtlc.cltv } }
      : {};
    const htlc = { ...frcHtlc, ...btcRestore };
    // a LEGACY (v1) swap can't be advanced by the v2 engine — resurrect it only when I have
    // funds LOCKED in it (the refund machinery needs the record); a fundless v1 take is dead.
    if (o.v !== 2 && !htlc.funding && !htlc.btcHtlc) return;
    const prev = loadP2p().find(r => r.id === o.id);
    if (prev) {   // enrich a bare record with whichever HTLC material it's missing
      const patch = {};
      if (htlc.funding && !prev.funding?.txid) Object.assign(patch, frcHtlc);
      if (htlc.btcHtlc && !prev.btcHtlc?.txid) Object.assign(patch, btcRestore);
      if (Object.keys(patch).length) putP2p({ ...prev, ...patch });
      return;
    }
    putP2p({ id: o.id, role, ...(o.dir === 'sellBtc' ? { dir: 'sellBtc' } : {}), ...(o.parent ? { parent: o.parent } : {}),
      nonce: n, status: o.status === 'open' ? 'open' : 'taken', partial: !!o.partial,
      assetTag: o.assetTag ?? null, frcAmount: o.frcAmount, btcAmount: o.btcAmount, paymentHash: o.paymentHash ?? null, ...htlc });
  };
  // v2 children reuse the OFFER's maker keys — remember every maker pub I can derive (existing
  // records + matches made below) so a child's maker side is recognized without brute-force.
  const myMakerPubs = new Map();   // offer-level frcPub → nonce
  for (const r of loadP2p()) if (r.nonce && r.role === 'maker') { try { myMakerPubs.set(pubkeyCompressed(p2pKey(r.nonce, 'frc')), r.nonce); } catch {} }
  const found = (o, role, n) => {
    if (!known.has(n)) { addBtcNonce(n); known.add(n); }
    if (role === 'maker' && o.maker?.frcPub) myMakerPubs.set(o.maker.frcPub, n);
    synth(o, role, n);
    resurrect(o, role, n);
  };
  for (const o of offers) {
    try {
      // a partial-fill CHILD lives under a parent offer and uses its OWN key derivations
      const par = o.parent ?? (o.id.includes('.') ? o.id.slice(0, o.id.lastIndexOf('.')) : null);
      const tn = nonceOf('fw-p2p-take:' + o.id);   // taker of a WHOLE offer
      if (o.taker && pubkeyCompressed(p2pKey(tn, 'frc')) === o.taker.frcPub) { found(o, 'taker', tn); continue; }
      if (par) {
        // MAKER of a v2 child: offer-level keys — match against the pubs I already know
        if (o.maker?.frcPub && myMakerPubs.has(o.maker.frcPub)) { found(o, 'maker', myMakerPubs.get(o.maker.frcPub)); continue; }
        // MAKER of a LEGACY (v1) child: per-child key from the child id (one hash)
        const cn = nonceOf('fw-p2p-child:' + o.id);
        if (o.maker && pubkeyCompressed(p2pKey(cn, 'frc')) === o.maker.frcPub) { found(o, 'maker', cn); continue; }
      }
      // The nonce commits the height at which the offer was POSTED (maker) or the piece TAKEN
      // (child taker) — we don't know our own tip back then, so we search heights. The relay
      // stamps postedAt/takenAt, which turns a full-chain scan (impossible at mainnet heights)
      // into a ±SEARCH_SPAN window around the hint; without a hint we fall back to scanning down
      // from the tip, but only SEARCH_MAX blocks — a slow miss beats freezing the tab.
      const prefix = (o.dir === 'sellBtc' ? 'fw-p2p-nonce:B:' : 'fw-p2p-nonce:') + (o.assetTag || '');
      const wantPub = par ? o.taker?.frcPub : o.maker?.frcPub;
      if (!wantPub) continue;
      const hint = par ? o.takenAt : o.postedAt;
      const SEARCH_SPAN = 60, SEARCH_MAX = 3000;
      const heights = [];
      if (hint != null) { for (let d = 0; d <= SEARCH_SPAN; d++) { heights.push(hint + d); if (d) heights.push(hint - d); } }
      else for (let h = tip + 5, i = 0; h >= 0 && i < SEARCH_MAX; h--, i++) heights.push(h);
      let i = 0;
      for (const h of heights) {
        if (h < 0) continue;
        const n = par ? nonceOf('fw-p2p-take:' + par + ':' + o.frcAmount + ':' + h)
          : nonceOf(prefix + o.frcAmount + ':' + o.btcAmount + ':' + h);
        if (pubkeyCompressed(p2pKey(n, 'frc')) === wantPub) { found(o, par ? 'taker' : 'maker', n); break; }
        if ((++i & 127) === 0) await new Promise(r => setTimeout(r, 0));   // yield so the UI stays responsive
      }
    } catch {}
  }
}

/** BTC history for the Activity feed: completed swaps become TRADE items (both legs — FRC and
 *  BTC), remaining receives stay plain legs. Returns { legs, hideFrc } where hideFrc lists FRC
 *  txids the trade rows replace (the raw HTLC legs must not show twice). */
export async function mvBtcHistory() {
  if (!ctx.state && refresh) { try { await refresh(); } catch {} }   // first load: the market state isn't in yet — wait for it, don't return an empty list
  if (!ctx.state?.swap?.available) return { legs: [], hideFrc: [] };
  try {
    await recoverBtcNonces();
    const r = await api('btcHistory', { addresses: Object.keys(btcKeyring()) });
    const all = (r.txs || []).map(t => ({ txid: t.txid, category: t.category, amount: t.amount, confirmations: t.confirmations, time: t.time, addresses: t.addresses || [], assetTag: null, btc: true }));
    // Harvest every HTLC-funding txid the relay knows (live swaps, which it resolves via listunspent,
    // plus the completed-swap archive) into the permanent hide-set. A funding txid only shows up among
    // MY sends if I broadcast it, so this retroactively folds orphaned funding sends (paid before the
    // local record carried a txid) into their trade rows — and other parties' funding txids are no-ops.
    let relaySwaps = [];
    try { const pl = await api('p2pList'); relaySwaps = [...(pl.swaps || []), ...(pl.archive || [])]; for (const w of relaySwaps) addFundTxid(w.btcHtlc?.txid); } catch {}
    const tagOf = new Map(relaySwaps.map(w => [w.id, w.assetTag ?? null]));   // backfill asset identity for old hist rows
    pruneSwapHist();
    const hist = loadSwapHist(), used = new Set(), items = [];
    const receives = all.filter(t => t.category === 'receive');
    // sends that fund a swap's BTC HTLC are swap plumbing — hide them. Cover BOTH completed trades
    // (btcFundTxid on the hist row) AND in-flight swaps (the live record's btcHtlc.txid), so a just-
    // paid funding tx never shows as a standalone "−0.00011 send" while the swap is still running.
    const fundTxids = new Set([...hist.map(h => h.btcFundTxid), ...loadP2p().map(r => r.btcHtlc?.txid), ...loadFundTxids()].filter(Boolean));
    for (const t of loadRefundedFunds()) fundTxids.delete(t);   // refunded swaps: show the funding send again (ledger honesty)
    const sends = all.filter(t => t.category === 'send' && !fundTxids.has(t.txid));
    for (const h of hist) {
      // DIRECTION is asset-centric (the holder's view), not BTC-centric: a swap that CLAIMS BTC (it has
      // a claim txid/addr) is me GIVING the asset → a SALE; one that only FUNDS BTC (btcFundTxid) is me
      // GETTING the asset → a PURCHASE. The stored `category` was inconsistent across directions, so we
      // derive it structurally here instead of trusting it.
      const gotBtc = !!(h.btcTxid || h.btcAddr);
      const recv = receives.find(t => t.txid === h.btcTxid)
        || (h.btcAddr ? receives.find(t => !used.has(t.txid) && t.addresses.includes(h.btcAddr)) : null)
        // net = gross − the claim fee; the fee is now dynamic, so match within a tolerance band
        // (0..~1000 sat) instead of the old fixed 2000 — a stale constant simply failed to match
        // and showed the gross amount.
        || (gotBtc ? receives.find(t => { if (used.has(t.txid) || !t.addresses.includes(btcAcctAddr())) return false; const d = Number(h.btcAmount) - Math.round(t.amount * 1e8); return d >= 0 && d <= 1200; }) : null);
      if (recv) used.add(recv.txid);
      const tag = h.assetTag ?? tagOf.get(h.id) ?? null;
      // Render the asset/FRC leg in the SAME units the exchange BOARD uses (scaleOf), and mark it
      // pre-scaled (`unit`) so the activity renderer shows it verbatim instead of re-dividing by its own
      // decimals table — the two tables can disagree, which made a "1 Test1" sale read "0.0001".
      const nbDisp = tag ? Number(BigInt(h.frcAmount)) / scaleOf(tag) : Number(BigInt(h.frcAmount)) / 1e8;
      const btcAmt = recv ? recv.amount : Number(BigInt(h.btcAmount)) / 1e8;
      const assetLeg = s => tag ? { amount: s * nbDisp, assetTag: tag, unit: assetName(tag) } : { amount: s * nbDisp };
      const btcLeg = s => ({ amount: s * btcAmt, btc: true });
      items.push({ trade: true, txid: recv?.txid || h.btcTxid || h.id, time: recv?.time || h.time || 0, confirmations: recv?.confirmations ?? 1,
        category: gotBtc ? 'sale' : 'purchase', assetName: tag ? assetName(tag) : 'FRC', frcTxid: h.frcTxid ?? null,
        recv: gotBtc ? btcLeg(1) : assetLeg(1),
        paid: gotBtc ? assetLeg(-1) : btcLeg(-1) });
    }
    // drop receives that are really the OUTPUT side of our own plumbing txs (HTLC-funding change,
    // the legacy→BIP84 migration sweep): an internal move is not income. Swap income is unaffected —
    // claim txids never appear in the funding book.
    items.push(...receives.filter(t => !used.has(t.txid) && !fundTxids.has(t.txid)), ...sends);   // non-swap receives + real outgoing sends
    // hide the FRC/asset legs of COMPLETED trades (hist) AND of my IN-FLIGHT locks (live records,
    // incl. parked ':stale' ones): a running swap lives on the exchange board, not as a raw
    // "−1 Test1 send" in the feed. If the swap dies, the refund drops the record and both the
    // lock and the refund legs surface again — the ledger explains the round-trip.
    const liveLocks = loadP2p().map(r => r.funding?.txid).filter(Boolean);
    return { legs: items, hideFrc: [...hist.map(h => h.frcTxid).filter(Boolean), ...liveLocks] };
  } catch { return { legs: [], hideFrc: [] }; }
}
