// mv-swap-lib.mjs — low-level nv3 coin selection, input signing and HTLC funding shared by BOTH the
// offer-posting/fill paths (market-view) and the swap drive (mv-swap-drive). Extracted verbatim; reads
// the live session (utxos, spks, key map) through `ctx`.
import { ctx, api, HOST_TAG, rateOf, isNv3Net } from '@/state/market-ctx.mjs';
import { assetPresentValue } from '@core/assets.mjs';
import { serializeTx, NV3_TX_VERSION } from '@core/tx.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '@core/sighash.mjs';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { tr } from '@/services/i18n.mjs';

const rev = h => h.match(/../g).reverse().join('');
// a vin entry from an "txid:vout" outpoint string
export const opIn = op => ({ prevout: { txid: rev(op.split(':')[0]), vout: +op.split(':')[1] }, scriptSig: '', sequence: 0xffffffff, witness: [] });

// sign input i as a P2WPKH-in-P2WSH host spend (the wallet's own key from ctx.km[spk])
export const signInput = (tx, i, spk, value, refheight, hashtype) => {
  const node = ctx.km[spk];
  const sec = node.priv.toString(16).padStart(64, '0');
  const code = '21' + pubkeyCompressed(sec) + 'ac';
  const sh = segwitV0Sighash(tx, i, code, BigInt(value), BigInt(refheight), hashtype);
  tx.vin[i].witness = [signEcdsa(sec, sh) + hashtype.toString(16).padStart(2, '0'), '00' + code, ''];
};

// outpoints that back my own OPEN ranged offers — reserved, so coin selection (new offers, fills,
// fees, cancels) never spends a coin out from under a live offer and orphans it.
export const committedOutpoints = () => new Set((ctx.state?.info?.book || [])
  .filter(o => o.ranged && o.status === 'open' && ctx.spks.includes(o.makerSpk) && o.giveOutpoint)
  .map(o => o.giveOutpoint));

// spendable FRC (kria), present-valued, EXCLUDING coins that back my open ranged offers — this is
// exactly what sendFrcToSpk can gather to fund a swap HTLC. The offer modal shows it so a maker
// can't post a P2P swap larger than they can actually lock (which stalls the swap at 'taken').
export const freeFrcKria = () => {
  if (!ctx.state) return 0n;
  const L = ctx.state.mine.height, reserved = committedOutpoints();
  return ctx.state.mine.utxos
    .filter(u => (u.assetTag ?? null) === null && u.refheight <= L && !reserved.has(u.outpoint))
    .reduce((a, u) => a + assetPresentValue(BigInt(u.value), L - u.refheight, { k: 20, interest: false }), 0n);
};

// my spendable coins of one asset (null tag = FRC), present-valued at height L, minus reserved ones
export function myCoinsOf(tag, L, reserved = committedOutpoints()) {
  const norm = tag === HOST_TAG ? null : tag;
  // token-bearing coins are excluded: spending one without revealing its set is consensus-invalid,
  // so fungible flows must never sweep them — they move only through the token-send flow
  return ctx.state.mine.utxos.filter(u => (u.assetTag ?? null) === norm && !u.tokenHash && u.refheight <= L && !reserved.has(u.outpoint))
    .map(u => ({ outpoint: u.outpoint, spk: u.spk, value: BigInt(u.value), refheight: u.refheight,
                 pv: assetPresentValue(BigInt(u.value), L - u.refheight, rateOf(norm)) }));
}

// pay `amount` kria of FRC to an arbitrary scriptPubKey (funds the FRC HTLC). Fee + change to us.
// NETWORK-AWARE VERSION: only an nv3 chain accepts NV3_TX_VERSION. A host-FRC spend has no
// assetTag to serialize, so on mainnet/testnet it is built as a plain version-2 transaction (which
// the nv3 node also accepts) — this is what lets the BTC↔FRC swap run outside the asset chain.
export async function sendFrcToSpk(spk, amount) {
  const L = ctx.state.mine.height, fee = 10000n, reserved = committedOutpoints();
  const coins = ctx.state.mine.utxos.filter(u => (u.assetTag ?? null) === null && u.refheight <= L && !reserved.has(u.outpoint))
    .map(u => ({ outpoint: u.outpoint, spk: u.spk, value: BigInt(u.value), refheight: u.refheight,
                 pv: assetPresentValue(BigInt(u.value), L - u.refheight, { k: 20, interest: false }) }))
    .sort((a, b) => (b.pv > a.pv ? 1 : b.pv < a.pv ? -1 : 0));
  const picked = []; let S = 0n;
  for (const c of coins) { picked.push(c); S += c.pv; if (S >= amount + fee) break; }
  if (S < amount + fee) throw new Error(tr('not enough FRC for this swap'));
  const nv3 = isNv3Net();
  const out = (value, scriptPubKey) => nv3 ? { value, scriptPubKey, assetTag: HOST_TAG } : { value, scriptPubKey };
  const vout = [out(amount, spk)];
  if (S - amount - fee > 0n) vout.push(out(S - amount - fee, ctx.spks[0]));
  const tx = { version: nv3 ? NV3_TX_VERSION : 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, ...(nv3 ? { nExpireTime: 0 } : {}), vin: picked.map(c => opIn(c.outpoint)), vout };
  picked.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  return { txid, vout: 0 };
}

// pick an unreserved host coin worth ≥ `need` (present value) for a network fee, with the material
// the asset-HTLC spend builder needs (its private key + witness scriptCode).
export function hostFeeCoin(L, need, reserved = committedOutpoints()) {
  const c = ctx.state.mine.utxos.find(u => (u.assetTag ?? null) === null && u.refheight <= L && !reserved.has(u.outpoint)
    && assetPresentValue(BigInt(u.value), L - u.refheight, { k: 20, interest: false }) >= need);
  if (!c) return null;
  const sec = ctx.km[c.spk].priv.toString(16).padStart(64, '0');
  const [txid, vout] = c.outpoint.split(':');
  return { txid, vout: +vout, value: BigInt(c.value), refheight: c.refheight, spk: c.spk,
    pv: assetPresentValue(BigInt(c.value), L - c.refheight, { k: 20, interest: false }),
    key: sec, script: '21' + pubkeyCompressed(sec) + 'ac', changeSpk: ctx.spks[0] };
}

// lock exactly `amount` base units of `tag` into the HTLC spk. Like mvSendAsset but paying an HTLC
// (asset conserves; the fee is a separate host coin). Returns the funding outpoint for the swap.
export async function lockAssetToHtlc(spk, tag, amount) {
  const L = ctx.state.mine.height, fee = 10000n, reserved = committedOutpoints();
  const coins = myCoinsOf(tag, L, reserved);
  if (coins.reduce((s, c) => s + c.pv, 0n) < amount) throw new Error(tr('not enough of that asset'));
  const picked = []; let S = 0n;
  for (const c of [...coins].sort((a, b) => (b.pv > a.pv ? 1 : b.pv < a.pv ? -1 : 0))) { picked.push(c); S += c.pv; if (S >= amount) break; }
  const feeCoin = hostFeeCoin(L, fee + 1000n, new Set([...reserved, ...picked.map(c => c.outpoint)]));
  if (!feeCoin) throw new Error(tr('you need an FRC coin (tap Faucet) for the network fee'));
  const vout = [{ value: amount, scriptPubKey: spk, assetTag: tag }];
  if (S - amount > 0n) vout.push({ value: S - amount, scriptPubKey: ctx.spks[0], assetTag: tag });   // asset change
  if (feeCoin.pv - fee > 0n) vout.push({ value: feeCoin.pv - fee, scriptPubKey: ctx.spks[0], assetTag: HOST_TAG });   // host change
  const inputs = [...picked.map(c => ({ outpoint: c.outpoint, spk: c.spk, value: c.value, refheight: c.refheight })),
    { outpoint: `${feeCoin.txid}:${feeCoin.vout}`, spk: feeCoin.spk, value: feeCoin.value, refheight: feeCoin.refheight }];
  const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0, vin: inputs.map(c => opIn(c.outpoint)), vout };   // plain asset move ⇒ standard v2
  inputs.forEach((c, i) => signInput(tx, i, c.spk, c.value, c.refheight, SIGHASH_ALL));
  const { txid } = await api('tx', { rawtx: serializeTx(tx), kind: 'send' });
  return { txid, vout: 0, value: String(amount), refheight: L };
}
