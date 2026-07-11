// auctions.mjs — the whitepaper's auction family as APPLICATION PATTERNS over the DEX
// primitives. No new consensus for any of them:
//
//   DUTCH    (descending price) — already proven in dex tests: a ladder of expiring RANGED
//            offers over one coin; double-spend makes rungs mutually exclusive, nExpireTime
//            enforces the schedule. Fully trustless, seller can be offline.
//   ENGLISH  (ascending bids) — bidders post BUNDLES ("my money → the lot to me"), each with
//            the auction deadline as its expiry; at close the SELLER countersigns the best
//            bid with their lot leg. Bidders are trustless (a bundle binds its terms and dies
//            at the deadline); the seller is online once, at close — exactly a real
//            auctioneer's role. Losing bids simply expire unspent.
//   DOUBLE   (continuous two-sided book) — this is literally the DEX book: makers post both
//            sides, matchBook clears every cross. Nothing to add.
import { makeBundle, composeBundles, findCross, matchMany } from './dex.mjs';

/** A bid: the bidder's money against the lot, dying at the auction deadline. `lot` names
 *  what is being auctioned ({assetId, value} the bidder expects). */
export function makeBid({ bidder, funds, price, lot, deadline, lockHeight, changeScript }) {
  const change = funds.reduce((a, f) => a + f.coin.value, 0n) - price;
  if (change < 0n) throw new Error('bid exceeds funds');
  return {
    bidder, price,
    bundle: makeBundle({
      inputs: funds,
      outputs: [
        { assetId: lot.assetId, value: lot.value, scriptPubKey: bidderScriptOf(funds, changeScript) },
        ...(change > 0n ? [{ assetId: funds[0].coin.assetId, value: change, scriptPubKey: changeScript }] : []),
      ],
      nExpireTime: deadline,
      lockHeight,
    }),
  };
}
const bidderScriptOf = (funds, changeScript) => changeScript;   // lot goes to the bidder's script

/** Close an ENGLISH auction: the seller picks the highest live bid and countersigns it with
 *  their lot leg (their coin → the winner is already inside the bid bundle's expectations;
 *  the seller's own bundle takes the winning price and returns any lot remainder). */
export function closeEnglish(state, bids, { seller, lot, atHeight, lockHeight, txid, fee = 0n }) {
  const live = bids.filter(b => (b.bundle.nExpireTime ?? 0) === 0 || b.bundle.nExpireTime >= atHeight);
  if (!live.length) throw new Error('no live bids');
  const best = live.reduce((a, b) => (b.price > a.price ? b : a));
  const lotPv = state.presentValueOf(seller.lotCoin.coin, lockHeight);
  const sellerLeg = makeBundle({
    inputs: [seller.lotCoin],
    outputs: [
      { assetId: seller.payoutAsset, value: best.price - fee, scriptPubKey: seller.script },  // proceeds
      ...(lotPv > lot.value ? [{ assetId: seller.lotCoin.coin.assetId, value: lotPv - lot.value, scriptPubKey: seller.script }] : []),
    ],
    lockHeight,
  });
  const { ctx, spread } = composeBundles(state, [best.bundle, sellerLeg], {
    lockHeight, atHeight, txid,
    matcher: { funds: [], script: seller.script, fee },
  });
  return { ctx, winner: best.bidder, price: best.price, spread };
}

/** Continuous DOUBLE auction = clear every cross in the book (the DEX matcher's job). */
export function matchBook(state, book, { lockHeight, matcher, mkTxid, atHeight }) {
  const fills = [];
  for (;;) {
    const pair = findCross(state, book.filter(o => o.status !== 'filled'), lockHeight);
    if (!pair) break;
    const open = book.filter(o => o.status !== 'filled');
    const [a, b] = [open[pair[0]], open[pair[1]]];
    const { tx, spread } = matchMany(state, [a, b], { lockHeight, atHeight, txid: mkTxid(fills.length), matcher });
    state.apply(tx, atHeight ?? lockHeight);
    a.status = b.status = 'filled';
    fills.push({ tx, spread });
  }
  return fills;
}
