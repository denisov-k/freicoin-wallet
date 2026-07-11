// dex.mjs — executable model of the Freimarkets DEX, phase 1: partial offers on the CURRENT
// nV3 consensus (no fork beyond nVersion=3-lite itself). An OFFER is one input + one output
// at the SAME index, signed SIGHASH_SINGLE|ANYONECANPAY: the maker's signature commits
// exactly "you may take this coin of mine IF this exact output (asset, amount, script) is at
// my index" — everything else in the transaction is someone else's business. A MATCHER (a
// miner, or anyone) splices two crossing offers into one balanced transaction, adds their own
// funds for the fee, and keeps the spread. Both makers can be OFFLINE at match time.
//
// This is the whitepaper's §2.3/§5.2 idea realized without nested sub-transactions: the
// nested format (phase 2) generalizes it — partial fills, >2-way rings, covenants — but the
// economic core (open offers, miner-matched, trustless settlement) is fully here.
//
// Layer note: this model works at the Nv3State level (conservation-checked), signature
// realism (the actual SINGLE|ACP digests) lives in core/sighash.mjs + the regtest demo.
import { FRC } from './assets.mjs';

/** An offer: "I give this coin; I want `want` paid to me."
 *  give: an outpoint string + its coin {assetId, value, refheight} (the maker's).
 *  want: {assetId, value, scriptPubKey} — the output the maker's signature demands at their
 *  own index. Returns the order-book entry. */
export function makeOffer({ outpoint, coin, want }) {
  if (!outpoint || !coin || !want) throw new Error('offer needs outpoint, coin, want');
  if (coin.assetId === want.assetId) throw new Error('offer must trade one asset for another');
  return { outpoint, coin, want, sighash: 'SINGLE|ANYONECANPAY' };
}

/** Do two offers cross? a gives what b wants and vice versa (same pair, opposite sides),
 *  and each maker's give covers the other's want in PRESENT VALUE at lockHeight (the give
 *  melts/grows by its own asset's rate; the want is a fresh nominal output). */
export function offersCross(state, a, b, lockHeight) {
  if (a.coin.assetId !== b.want.assetId || b.coin.assetId !== a.want.assetId) return false;
  const pvA = state.presentValueOf(a.coin, lockHeight);
  const pvB = state.presentValueOf(b.coin, lockHeight);
  return pvA >= b.want.value && pvB >= a.want.value;
}

/** Splice two crossing offers into one balanced tx the consensus will accept.
 *  matcher: { funds: [{outpoint, coin}] (host-currency, pays the fee), script (their spk),
 *  fee (kria of host currency to leave the miner — 0 if the matcher IS the miner) }.
 *  Layout (SIGHASH_SINGLE binds output index == input index):
 *    input[0] = a.give   output[0] = a.want
 *    input[1] = b.give   output[1] = b.want
 *    input[2..] = matcher funds; output[2..] = matcher spread/change outputs.
 *  Returns {tx, spread: Map assetId->kria} or throws when the offers don't cross. */
export function matchOffers(state, a, b, { lockHeight, matcher, txid }) {
  if (!offersCross(state, a, b, lockHeight)) throw new Error('offers do not cross');
  const inputs = [a.outpoint, b.outpoint, ...matcher.funds.map(f => f.outpoint)];
  const outputs = [
    { assetId: a.want.assetId, value: a.want.value, scriptPubKey: a.want.scriptPubKey },
    { assetId: b.want.assetId, value: b.want.value, scriptPubKey: b.want.scriptPubKey },
  ];
  const spread = new Map();

  // per-asset surplus: give PV minus what the counter-offer's want consumes of it
  const surplus = (give, otherWant) =>
    state.presentValueOf(give.coin, lockHeight) - otherWant.value;
  const sA = surplus(a, b.want);   // asset a gives (goes to matcher as change)
  const sB = surplus(b, a.want);   // asset b gives

  // non-host assets must conserve EXACTLY -> surplus goes to the matcher, always as an output.
  // host-currency surplus joins the matcher's funds and leaves fee + change.
  let hostIn = 0n;
  for (const f of matcher.funds) {
    if (f.coin.assetId !== FRC) throw new Error('matcher funds must be host currency');
    hostIn += state.presentValueOf(f.coin, lockHeight);
  }
  for (const [asset, s] of [[a.coin.assetId, sA], [b.coin.assetId, sB]]) {
    if (asset === FRC) { hostIn += s; continue; }
    if (s > 0n) {
      outputs.push({ assetId: asset, value: s, scriptPubKey: matcher.script });
      spread.set(asset, (spread.get(asset) || 0n) + s);
    }
  }
  const fee = matcher.fee ?? 0n;
  const hostChange = hostIn - fee;
  if (hostChange < 0n) throw new Error('matcher cannot cover the fee');
  if (hostChange > 0n) {
    outputs.push({ assetId: FRC, value: hostChange, scriptPubKey: matcher.script });
    spread.set(FRC, (spread.get(FRC) || 0n) + hostChange
      - matcher.funds.reduce((acc, f) => acc + state.presentValueOf(f.coin, lockHeight), 0n));
  }

  const tx = { txid, lockHeight, inputs, outputs };
  const v = state.check(tx);
  if (!v.ok) throw new Error(`matched tx invalid: ${v.err}`);
  return { tx, spread };
}

/** Scan an order book (array of offers) for the first crossing pair. O(n^2), fine for a
 *  model; a real matcher indexes by asset pair + price. Returns [i, j] or null. */
export function findCross(state, book, lockHeight) {
  for (let i = 0; i < book.length; i++)
    for (let j = i + 1; j < book.length; j++)
      if (offersCross(state, book[i], book[j], lockHeight)) return [i, j];
  return null;
}

/** Implied price of an offer (want per give, as a rational pair — no floats in kria-land). */
export function offerPrice(offer) {
  return { num: offer.want.value, den: offer.coin.value, pair: `${offer.want.assetId}/${offer.coin.assetId}` };
}
