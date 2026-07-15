// mv-storage.mjs — the wallet's local persistence layer for the exchange/swap features.
// PURE localStorage: no seed, no live `state` — just typed JSON buckets. Extracted from
// market-view.mjs verbatim (behaviour-preserving) so the swap/BTC/activity logic can be split next.
import { currentNet } from '@/services/wallet.mjs';

// FRC-side records are PER-NETWORK: nv3 and testnet run separate chains + relays, and a record
// from one is a ghost on the other (switching networks used to wipe/mix them). nv3 keeps the
// legacy bare keys so existing records survive. BTC-side books (nonces, funding/refund txid
// marks) stay GLOBAL — both networks share the one signet BTC account.
export const lsKey = base => currentNet() === 'nv3' ? base : `${base}:${currentNet()}`;

// ---- LP swaps I funded (legacy direct-swap). Refundable from these (+ the seed) after their T1. ----
const SWAP_LS = 'fw_swaps';
export const loadMySwaps = () => { try { return JSON.parse(localStorage.getItem(lsKey(SWAP_LS)) || '[]'); } catch { return []; } };
export const saveMySwaps = a => { try { localStorage.setItem(lsKey(SWAP_LS), JSON.stringify(a)); } catch {} };
export const putMySwap = rec => { const a = loadMySwaps().filter(x => x.id !== rec.id); a.push(rec); saveMySwaps(a); };
export const dropMySwap = id => saveMySwaps(loadMySwaps().filter(x => x.id !== id));

// ---- P2P swaps (both roles/directions). The drive loop advances these (and refunds on stall);
// keys/secret derive from the seed elsewhere. ----
const P2P_LS = 'fw_p2p';
export const loadP2p = () => { try { return JSON.parse(localStorage.getItem(lsKey(P2P_LS)) || '[]'); } catch { return []; } };
export const saveP2pLocal = a => { try { localStorage.setItem(lsKey(P2P_LS), JSON.stringify(a)); } catch {} };
export const putP2p = rec => { const a = loadP2p().filter(x => x.id !== rec.id); a.push(rec); saveP2pLocal(a); };
export const dropP2p = id => saveP2pLocal(loadP2p().filter(x => x.id !== id));

// ---- per-swap BTC address nonces. A completed swap's record is dropped (which would lose the nonce
// and orphan its per-swap BTC address); this book keeps every nonce so proceeds/refunds stay visible
// AND spendable forever. ----
const BTCADDR_LS = 'fw_btc_nonces';
export const loadBtcNonces = () => { try { return JSON.parse(localStorage.getItem(BTCADDR_LS) || '[]'); } catch { return []; } };
export const addBtcNonce = n => { try { const a = loadBtcNonces(); if (!a.includes(n)) { a.push(n); localStorage.setItem(BTCADDR_LS, JSON.stringify(a)); } } catch {} };

// ---- BTC HTLC funding txids I broadcast (forward taker paying, reverse maker locking): swap
// plumbing, never a user "send". Remembered PERMANENTLY so Activity always folds them into the trade
// row even if the swap record is later dropped (in-flight, done, or cancelled). ----
const FUNDTX_LS = 'fw_btc_fundtx';
export const loadFundTxids = () => { try { return JSON.parse(localStorage.getItem(FUNDTX_LS) || '[]'); } catch { return []; } };
export const addFundTxid = t => { try { const a = loadFundTxids(); if (t && !a.includes(t)) { a.push(t); localStorage.setItem(FUNDTX_LS, JSON.stringify(a)); } } catch {} };

// ---- exchange PLUMBING txids (ranged-offer give-coin consolidation / on-chain cancel): the asset
// returns to us net-zero and only the network fee shows — label those rows "exchange fee", not "send". ----
const FEETX_LS = 'fw_fee_tx';
export const loadFeeTxids = () => { try { return JSON.parse(localStorage.getItem(FEETX_LS) || '[]'); } catch { return []; } };
export const addFeeTxid = t => { try { const a = loadFeeTxids(); if (t && !a.includes(t)) { a.push(t); localStorage.setItem(FEETX_LS, JSON.stringify(a)); } } catch {} };

// ---- funding txids of swaps that FAILED and were refunded: the BTC went out then came back, so the
// funding send must be VISIBLE again (paired with the refund receive it explains the lost fees). ----
const REFUNDED_LS = 'fw_btc_refunded';
export const loadRefundedFunds = () => { try { return JSON.parse(localStorage.getItem(REFUNDED_LS) || '[]'); } catch { return []; } };
export const addRefundedFund = t => { try { const a = loadRefundedFunds(); if (t && !a.includes(t)) { a.push(t); localStorage.setItem(REFUNDED_LS, JSON.stringify(a)); } } catch {} };

// ---- completed-swap history → Activity TRADE rows. category: 'purchase' = bought BTC, 'sale' = sold
// BTC. frcTxid hides the raw FRC HTLC leg the trade row replaces; btcTxid/btcAddr tie the BTC receive. ----
const SWHIST_LS = 'fw_swap_hist';
export const loadSwapHist = () => { try { return JSON.parse(localStorage.getItem(lsKey(SWHIST_LS)) || '[]'); } catch { return []; } };
// upsert by id: a later, better-informed write WINS for non-empty fields (values are derived
// deterministically from the chain/archive, so re-runs converge — and corrected upstream data,
// e.g. a fixed funding txid, must be able to replace an earlier wrong value)
export const addSwapHist = e => { try {
  const a = loadSwapHist(), i = a.findIndex(x => x.id === e.id);
  if (i >= 0) { for (const [k, v] of Object.entries(e)) if (v != null && v !== 0) a[i][k] = v; }
  else a.push(e);
  localStorage.setItem(lsKey(SWHIST_LS), JSON.stringify(a));
} catch {} };
// drop swap-hist entries that can never render as a real trade — no chain reference at all
// (no btc receive/claim txid, no FRC claim/funding txid, no time): incomplete/stale ghosts.
export const pruneSwapHist = () => { try {
  const a = loadSwapHist().filter(h => h.btcTxid || h.frcTxid || h.btcFundTxid || h.btcAddr || h.time);
  localStorage.setItem(lsKey(SWHIST_LS), JSON.stringify(a));
} catch {} };
