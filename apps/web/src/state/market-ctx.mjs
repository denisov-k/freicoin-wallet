// mv-ctx.mjs — shared relay client + live wallet session for the exchange/swap modules.
// market-view.mjs owns the session (unlock/refresh) and MIRRORS it into `ctx` here; extracted feature
// modules (btc account, activity, swap drive) read from `ctx` instead of closing over market-view's
// private state. Keeping this tiny and dependency-light avoids import cycles.
import { sha256 } from '@core/crypto.mjs';
import { NETWORKS } from '@/state/network-params.mjs';
import { currentNet } from '@/services/wallet.mjs';

// relay base: same-origin /api* under TLS, else the dev relay port. Each network gets its OWN
// relay instance (separate chains, order book and swap state): nv3 → /api (:5181, demo),
// test → /api-test (:5182, rehearsal), main → /api-main (:5183, production).
const apiBase = () => {
  const { seg, port } = { test: { seg: 'api-test', port: 5182 }, main: { seg: 'api-main', port: 5183 } }[currentNet()]
    ?? { seg: 'api', port: 5181 };
  return location.protocol === 'https:' ? `${location.origin}/${seg}` : `http://${location.hostname}:${port}/api`;
};
export const API = apiBase; // legacy alias (call it)
export async function api(path, body) {
  const r = await fetch(`${apiBase()}/${path}`, body ? { method: 'POST', body: JSON.stringify(body, (k, v) => typeof v === 'bigint' ? String(v) : v) } : undefined);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

// live wallet session, mirrored from market-view: seed = hex seed; spks = wallet scriptPubKeys;
// km = { spk → key node } for signing; state = the latest {info, defs, mine, swap, p2p} snapshot.
export const ctx = { seed: null, spks: [], km: {}, state: null };

// per-swap key derivation (needs the seed) — shared so the BTC/swap modules can derive the same keys.
export const p2pKey = (nonce, leg) => sha256(Buffer.from(ctx.seed + 'fw-p2p:' + nonce + ':' + leg, 'utf8')).toString('hex');

// Does the CURRENT network run the nVersion=3-lite consensus (assets + DEX)? Only there may a
// transaction carry NV3_TX_VERSION / assetTag outputs — mainnet and testnet reject it, so the
// cross-chain swap's FRC leg must be built as a plain v2 tx there. Assets/DEX only exist on nv3
// anyway, so their builders can stay NV3-only.
export const isNv3Net = () => !!NETWORKS[currentNet()]?.nv3;
// the network key the HTLC ADDRESS is encoded for — always the wallet's current chain (a hardcoded
// 'regtest' would mint fcrt1 escrow addresses on mainnet)
export const swapNet = () => currentNet();

// ---- BTC fees, priced from the relay's live estimator (sat/vB) ----
// A FLAT fee is wrong on mainnet in both directions: too low and the claim never confirms (an
// atomic swap that misses its timelock LOSES the money), too high and it eats a small trade. The
// relay serves `feeRate` in p2pList (cached, clamped); we multiply by each tx's real vsize.
// Fallback 2 sat/vB if the relay hasn't answered yet — never zero.
export const btcFeeRate = () => Number(ctx.state?.p2p?.feeRate ?? 2);
export const VB_HTLC_FUND = 200;    // P2WPKH in → P2WSH out + change
export const VB_HTLC_SPEND = 170;   // P2WSH HTLC claim/refund (preimage/sig witness) → P2WPKH out
export const btcFeeFor = vbytes => { const f = BigInt(Math.ceil(btcFeeRate() * vbytes)); return f > 200n ? f : 200n; };
// ECONOMY tariff for plain BTC sends. Swap HTLC txs must confirm before their timelocks, so they
// price at the estimator rate with a safety floor (btcFeeFor above). A plain transfer has no
// deadline: it can ride the honest mempool floor (feeMin from the relay, 1 sat/vB on a quiet
// mempool) at the tx's ACTUAL vsize — never below 1 sat/vB of that vsize (the relay minimum).
export const btcFeeMinRate = () => Number(ctx.state?.p2p?.feeMin ?? btcFeeRate());
export const btcSendVb = (nIn, nOut) => 11 + nIn * 68 + nOut * 31;   // P2WPKH in/out vsize
// two plain-send tariffs, selectable per send: 'eco' rides the mempool floor (no deadline), 'fast'
// pays the estimator rate for next-block-ish confirmation. Both bill the tx's ACTUAL vsize and never
// go below 1 sat/vB of it (the relay minimum).
export const btcSendRate = fast => Math.max(1, fast ? btcFeeRate() : btcFeeMinRate());
export const btcSendFee = (nIn, nOut, fast = false) => { const vb = btcSendVb(nIn, nOut); const f = BigInt(Math.ceil(btcSendRate(fast) * vb)); const m = BigInt(vb); return f > m ? f : m; };

// ---- shared asset display helpers (read the live defs from ctx.state) ----
export const HOST_TAG = '00'.repeat(20);
// kria per DISPLAY unit: FRC = 1e8 (8 decimals); user assets = 10^decimals from their self-certified
// "name|D" suffix (legacy assets without one are indivisible integer tokens).
// SOURCE ORDER: the relay's FRESH from-chain read FIRST, then the light client's def. Decimals are
// self-certified on-chain (the relay parses the "name|D" suffix each session), whereas the light
// client's local copy is seed-derived for assets it can't scan (non-issuer) and a STALE seeded value
// there once poisoned the scale — making a whole "1 Test1" render as "0.0001". The relay value can only
// mislabel (never mis-move funds), and matches the trustless scan for self-issued assets anyway.
export const decimalsOf = tag => Number(ctx.state?.info?.assets?.find(a => a.tag === tag)?.decimals ?? ctx.state?.defs?.[tag]?.decimals ?? 0);
export const scaleOf = tag => (tag == null || tag === HOST_TAG || tag === 'FRC') ? 100000000 : 10 ** decimalsOf(tag);
// self-certified name from the light client first, then the relay's (untrusted, cosmetic), then the tag.
export const assetName = tag => tag === null || tag === HOST_TAG ? 'FRC'
  : (ctx.state?.defs?.[tag]?.name ?? ctx.state?.info?.assets?.find(a => a.tag === tag)?.name ?? tag.slice(0, 8) + '…');
// asset demurrage/interest rate: the light client's self-certified def (trustless) first, then the
// relay's (untrusted, flagged). FRC = the host rate. A wrong rate can only mislabel, not misprice.
export const rateOf = tag => {
  if (tag === null || tag === HOST_TAG) return { k: 20, interest: false };
  const d = ctx.state?.defs?.[tag];
  if (d) return { k: d.shift, interest: d.interest };
  const a = ctx.state?.info?.assets?.find(x => x.tag === tag);
  return a ? { k: a.shift, interest: a.interest } : { k: 20, interest: false };
};
