// English + double auctions as application patterns (Dutch already proven in dex.test).
import { check, finish } from './helpers.mjs';
import { FRC, assetIdOf } from '../../../core/assets.mjs';
import { Nv3State } from '../../../core/nv3chain.mjs';
import { bundleId, makeOffer } from '../../../core/dex.mjs';
import { makeBid, closeEnglish, matchBook } from '../../../core/auctions.mjs';

const spk = t => '0014' + t.repeat(20);
const st = new Nv3State();
const H = 7000, DEADLINE = 7020;

const coop = { k: 18, interest: false, granularity: 1 };
const idCoop = assetIdOf(coop);
st.apply({ txid: 'iss', lockHeight: H, def: coop,
  inputs: [st.seed('cb', 0, { assetId: FRC, value: 200000000n, refheight: H, scriptPubKey: spk('11') })],
  outputs: [{ assetId: idCoop, value: 500n, scriptPubKey: spk('se') },       // the LOT (seller's)
            { assetId: FRC, value: 199000000n, scriptPubKey: spk('11') }] });
['b1', 'b2', 'b3'].forEach((b, i) => st.seed(b, 0, { assetId: FRC, value: 50000000n, refheight: H, scriptPubKey: spk(b) }));

// ---- ENGLISH: three ascending bids on 500 coop; seller closes at the best ----
const lot = { assetId: idCoop, value: 500n };
const bid = (name, price) => makeBid({
  bidder: name, price, lot, deadline: DEADLINE, lockHeight: H,
  funds: [{ outpoint: `${name}:0`, coin: { assetId: FRC, value: 50000000n, refheight: H } }],
  changeScript: spk(name),
});
const bids = [bid('b1', 10000000n), bid('b2', 15000000n), bid('b3', 12000000n)];

const { ctx, winner, price } = closeEnglish(st, bids, {
  seller: { lotCoin: { outpoint: 'iss:0', coin: { assetId: idCoop, value: 500n, refheight: H } },
            payoutAsset: FRC, script: spk('se') },
  lot, atHeight: H + 10, lockHeight: H, txid: 'auc', fee: 10000n,
});
check('english: the highest bid wins', winner === 'b2' && price === 15000000n);
check('english: settlement passes consensus', st.applyComposite(ctx, H + 10).ok !== false);
check('english: winner got the lot', st.utxos.get('auc:0')?.assetId === idCoop && st.utxos.get('auc:0')?.value === 500n);
check('english: seller got the winning price (minus fee)', st.utxos.get('auc:2')?.value === 15000000n - 10000n);
check('english: losing bids remain unspent coins', st.utxos.has('b1:0') && st.utxos.has('b3:0'));
check('english: a bid cannot be altered by the seller (bundle id)',
  bundleId({ ...bids[0].bundle, outputs: [{ ...bids[0].bundle.outputs[0], value: 1n }, bids[0].bundle.outputs[1]] }) !== bids[0].bundle.id);

// after the deadline every remaining bid is dead — the auction cannot be closed late
let lateThrew = false;
try {
  closeEnglish(st, [bids[0], bids[2]], {
    seller: { lotCoin: { outpoint: 'auc:0', coin: { assetId: idCoop, value: 500n, refheight: H } },
              payoutAsset: FRC, script: spk('se') },
    lot, atHeight: DEADLINE + 1, lockHeight: H, txid: 'late', fee: 0n });
} catch (e) { lateThrew = /no live bids|expired/.test(e.message); }
check('english: closing after the deadline impossible', lateThrew);

// ---- DOUBLE: the book IS the double auction — sellers and buyers both post; clear all ----
const st2 = new Nv3State();
st2.apply({ txid: 'iss2', lockHeight: H, def: coop,
  inputs: [st2.seed('cb2', 0, { assetId: FRC, value: 200000000n, refheight: H, scriptPubKey: spk('11') })],
  outputs: [{ assetId: idCoop, value: 100n, scriptPubKey: spk('s1') },
            { assetId: idCoop, value: 100n, scriptPubKey: spk('s2') },
            { assetId: FRC, value: 198000000n, scriptPubKey: spk('11') }] });
st2.seed('m', 0, { assetId: FRC, value: 1000000n, refheight: H, scriptPubKey: spk('mm') });
st2.seed('m2', 0, { assetId: FRC, value: 1000000n, refheight: H, scriptPubKey: spk('mm') });
st2.seed('buy1', 0, { assetId: FRC, value: 4000000n, refheight: H, scriptPubKey: spk('c1') });
st2.seed('buy2', 0, { assetId: FRC, value: 3500000n, refheight: H, scriptPubKey: spk('c2') });

const book = [
  makeOffer({ outpoint: 'iss2:0', coin: { assetId: idCoop, value: 100n, refheight: H },   // ask 3.9e6
    want: { assetId: FRC, value: 3900000n, scriptPubKey: spk('s1') } }),
  makeOffer({ outpoint: 'iss2:1', coin: { assetId: idCoop, value: 100n, refheight: H },   // ask 3.4e6
    want: { assetId: FRC, value: 3400000n, scriptPubKey: spk('s2') } }),
  makeOffer({ outpoint: 'buy1:0', coin: { assetId: FRC, value: 4000000n, refheight: H },  // bid up to 4e6
    want: { assetId: idCoop, value: 100n, scriptPubKey: spk('c1') } }),
  makeOffer({ outpoint: 'buy2:0', coin: { assetId: FRC, value: 3500000n, refheight: H },  // bid up to 3.5e6
    want: { assetId: idCoop, value: 100n, scriptPubKey: spk('c2') } }),
];
book.forEach(o => o.status = 'open');
const matcherFunds = ['m:0', 'm2:0'][Symbol.iterator] ? null : null;
let mi = 0;
const fills = matchBook(st2, book, {
  lockHeight: H, mkTxid: n => `dbl${n}`,
  matcher: { get funds() { return [{ outpoint: `m${mi++ ? '2' : ''}:0`, coin: { assetId: FRC, value: 1000000n, refheight: H } }]; }, script: spk('mm'), fee: 1000n },
});
check('double: the book cleared both crosses', fills.length === 2);
check('double: all four makers filled', book.every(o => o.status === 'filled'));
check('double: buyers hold coop now',
  [...st2.utxos.values()].filter(u => u.assetId === idCoop && (u.scriptPubKey === spk('c1') || u.scriptPubKey === spk('c2'))).length === 2);

finish();
