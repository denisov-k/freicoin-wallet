// btc-recovery.mjs — reconstruct ORPHANED BTC HTLC fundings so their coins refund at the timeout.
//
// A cancelled/failed forward purchase can lose its local swap record before the funded BTC HTLC came
// home (the relay dropped the swap, and the drive dropped the record). The HTLC leaf/cltv lived only
// in that record, so nothing drives the timeout refund → the BTC is stranded on-chain. This rebuilds
// the record from durable inputs: my own swap nonces (fw_btc_nonces, never dropped) + the maker's
// OFFER-level claim key (still on the relay's open board / archive) + a small cltv brute-force to
// match the funded HTLC address. The rebuilt record is a normal taker/btc_funded entry, so the
// existing checkBtcRefunds sweeps it home once its CLTV passes — no separate refund path.
import { ctx, api, p2pKey } from '@/state/market-ctx.mjs';
import { loadP2p, putP2p, loadBtcNonces } from '@/services/storage.mjs';
import { btcKeyring, btcHrp } from '@/services/market/btc-account.mjs';
import { btcHtlcLeaf, btcHtlcAddress } from '@core/btc.mjs';
import { paymentHashOf } from '@core/htlc.mjs';
import { pubkeyCompressed } from '@core/ecdsa.mjs';

let lastScan = 0;
export async function recoverOrphanBtcHtlcs() {
  if (!ctx.seed || !ctx.state?.swap?.available) return;
  const now = Date.now();
  if (now - lastScan < 45_000) return;   // throttle — the extra history/utxo calls + brute-force
  lastScan = now;
  let hist, offers, btcH;
  try {
    const [h, pl] = await Promise.all([api('btcHistory', { addresses: Object.keys(btcKeyring()) }), api('p2pList')]);
    hist = h.txs || []; offers = [...(pl.swaps || []), ...(pl.archive || [])]; btcH = pl.btcHeight || 0;
  } catch { return; }
  if (!btcH) return;
  const mineAddrs = new Set(Object.keys(btcKeyring()));
  const known = new Set(loadP2p().map(r => r.btcHtlc?.addr).filter(Boolean));
  const makerPubs = [...new Set(offers.map(o => (o.maker || {}).btcPub).filter(Boolean))];
  if (!makerPubs.length) return;
  const nonces = loadBtcNonces(), hrp = btcHrp();
  // candidate HTLCs: my SENDS to a bech32 P2WSH address that is neither mine nor a swap I still track
  const cands = new Map();   // addr -> funding txid
  for (const t of hist) {
    if (t.category !== 'send') continue;
    for (const addr of (t.addresses || [])) {
      if (mineAddrs.has(addr) || known.has(addr) || cands.has(addr)) continue;
      if (!/^(bc1|tb1|bcrt1)[a-z0-9]{58,}$/.test(addr)) continue;   // P2WSH shape (a plain P2WPKH is 42 chars)
      cands.set(addr, t.txid);
    }
  }
  for (const [addr, ftxid] of cands) {
    // reconstruct the leaf: MY nonce (refund key + payment hash) × the maker's claim pub × the cltv
    let hit = null;
    outer:
    for (const nonce of nonces) {
      const refundPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
      const paymentHash = paymentHashOf(p2pKey(nonce, 'R'));
      for (const claimPub of makerPubs) {
        for (let cltv = btcH - 100; cltv <= btcH + 40; cltv++) {
          const leaf = btcHtlcLeaf({ paymentHash, claimPub, refundPub, cltv });
          if (btcHtlcAddress(leaf, hrp) === addr) { hit = { nonce, leaf, cltv, paymentHash }; break outer; }
        }
      }
    }
    if (!hit) continue;   // not my HTLC, or its params fell outside the scanned window
    // still funded (unspent)? fetch the funding output's vout + value
    let u;
    try { u = ((await api('btcAccount', { addresses: [addr] })).utxos || []).find(x => x.txid === ftxid); } catch {}
    if (!u) continue;   // already spent (refunded/claimed) — nothing to recover
    // rebuild a taker/btc_funded record; checkBtcRefunds sweeps it home once the CLTV passes.
    putP2p({ id: 'rec:' + ftxid.slice(0, 16), role: 'taker', dir: 'forward', nonce: hit.nonce, status: 'btc_funded',
      paymentHash: hit.paymentHash, frcAmount: '0', btcAmount: String(u.value),
      btcHtlc: { addr, leaf: hit.leaf, cltv: hit.cltv, txid: u.txid, vout: u.vout, value: u.value } });
  }
}
