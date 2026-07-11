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
export function matchOffers(state, a, b, { lockHeight, matcher, txid, atHeight }) {
  return matchMany(state, [a, b], { lockHeight, matcher, txid, atHeight });
}

/** Splice ANY set of offers whose asset flows balance — a pair, or an N-way RING (the
 *  whitepaper's transitive payments: A gives X wants Y, B gives Y wants Z, C gives Z wants
 *  X). Per asset, the sum given (present value at lockHeight) must cover the sum wanted;
 *  non-host surplus goes to the matcher as outputs, host surplus pays the fee + change.
 *
 *  Offers are valued at `lockHeight` (all makers signed that height); the tx may be MINED at
 *  any later height (`atHeight`, default lockHeight) — consensus only requires
 *  lock_height <= mining height, so a book of same-height offers stays matchable. */
export function matchMany(state, offers, { lockHeight, matcher, txid, atHeight }) {
  if (offers.length < 2) throw new Error('need at least two offers');
  // per-asset totals: what the offers give (PV) and want (fresh nominal)
  const given = new Map(), wanted = new Map();
  for (const o of offers) {
    given.set(o.coin.assetId, (given.get(o.coin.assetId) || 0n) + state.presentValueOf(o.coin, lockHeight));
    wanted.set(o.want.assetId, (wanted.get(o.want.assetId) || 0n) + o.want.value);
  }
  for (const [asset, w] of wanted) {
    if ((given.get(asset) || 0n) < w && asset !== FRC) throw new Error(`offers do not balance: asset ${asset} short`);
  }

  const inputs = [...offers.map(o => o.outpoint), ...matcher.funds.map(f => f.outpoint)];
  const outputs = offers.map(o => ({ assetId: o.want.assetId, value: o.want.value, scriptPubKey: o.want.scriptPubKey }));
  const spread = new Map();

  let hostIn = 0n;
  for (const f of matcher.funds) {
    if (f.coin.assetId !== FRC) throw new Error('matcher funds must be host currency');
    hostIn += state.presentValueOf(f.coin, lockHeight);
  }
  // host surplus may be NEGATIVE (offers collectively want more FRC than they give) —
  // then the matcher's funds subsidize the difference. Computed from both maps so an
  // FRC-wanting book with no FRC-giving offer is accounted correctly.
  hostIn += (given.get(FRC) || 0n) - (wanted.get(FRC) || 0n);
  for (const [asset, g] of given) {
    if (asset === FRC) continue;
    const s = g - (wanted.get(asset) || 0n);   // surplus of this asset
    if (s < 0n) throw new Error(`offers do not balance: asset ${asset} short`);
    if (s > 0n) {
      outputs.push({ assetId: asset, value: s, scriptPubKey: matcher.script });
      spread.set(asset, (spread.get(asset) || 0n) + s);
    }
  }
  // hostIn already includes the offers' host surplus (which is NEGATIVE when the offers
  // collectively want more FRC than they give — then the matcher's funds subsidize it).
  const fee = matcher.fee ?? 0n;
  const hostChange = hostIn - fee;
  if (hostChange < 0n) throw new Error('matcher cannot cover the fee');
  if (hostChange > 0n) {
    outputs.push({ assetId: FRC, value: hostChange, scriptPubKey: matcher.script });
    spread.set(FRC, (spread.get(FRC) || 0n) + hostChange
      - matcher.funds.reduce((acc, f) => acc + state.presentValueOf(f.coin, lockHeight), 0n));
  }

  const tx = { txid, lockHeight, inputs, outputs };
  const v = state.check(tx, atHeight ?? lockHeight);
  if (!v.ok) throw new Error(`matched tx invalid: ${v.err}`);
  return { tx, spread };
}

/** Find an N-way ring in the book: a cycle of offers where each one's want asset is the next
 *  one's give asset, and the amounts chain (each give covers the next want). Depth-first over
 *  asset edges, max ring size `maxLen`. Returns the offer array or null. */
export function findRing(state, book, lockHeight, maxLen = 4) {
  const open = book.filter(o => o.status !== 'filled');
  const walk = (chain, used) => {
    if (chain.length >= 2) {
      const head = chain[0], tail = chain[chain.length - 1];
      if (tail.want.assetId === head.coin.assetId) {
        // candidate ring: verify every leg is covered
        const ok = chain.every((o, i) => {
          const giver = chain[(i + 1) % chain.length];   // who supplies o's want
          return giver.coin.assetId === o.want.assetId
            && state.presentValueOf(giver.coin, lockHeight) >= o.want.value;
        });
        if (ok) return chain;
      }
    }
    if (chain.length >= maxLen) return null;
    const tail = chain[chain.length - 1];
    for (const o of open) {
      if (used.has(o)) continue;
      if (o.coin.assetId !== tail.want.assetId) continue;   // o supplies what tail wants
      used.add(o);
      const r = walk([...chain, o], used);
      if (r) return r;
      used.delete(o);
    }
    return null;
  };
  for (const o of open) {
    const r = walk([o], new Set([o]));
    if (r) return r;
  }
  return null;
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
