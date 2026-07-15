// tx-ranged.test.mjs — round-trip of the nVersion=3 DEX 2b ranged-bundle wire record
// (witness-side, flag bit 8). Pure serialization: no node/bridge needed. Field order must
// mirror the C++ CRangedBundle (primitives/transaction.h): nIn, payoutAsset(20), payoutScript,
// priceNum, priceDen, changeScript, minFill, maxFill, nExpireTime.
import { check, finish } from './helpers.mjs';
import { parseTx, serializeTx, NV3_TX_VERSION } from '../../../core/tx.mjs';

const HOST = '00'.repeat(20);
const coop = 'c0'.repeat(20);          // a 20-byte user-asset tag (40 hex chars)
const spk = t => '0014' + t.repeat(20);

// A composite: maker's give input + taker's payout+fee inputs; outputs [payout, change, fill],
// one ranged descriptor claiming the maker's single give input.
const tx = {
  version: NV3_TX_VERSION, hasWitness: true, nLockTime: 0, lockHeight: 3000, nExpireTime: 0,
  vin: [
    { prevout: { txid: '11'.repeat(32), vout: 0 }, scriptSig: '', sequence: 0xffffffff,
      witness: ['30ab', '0021' + '22'.repeat(33) + 'ac', ''] },                 // maker give (SIGHASH_BUNDLE)
    { prevout: { txid: '33'.repeat(32), vout: 1 }, scriptSig: '', sequence: 0xffffffff, witness: ['30cd', ''] },
  ],
  vout: [
    { value: 21000000n, scriptPubKey: spk('a2'), assetTag: HOST },              // payout to maker (FRC)
    { value: 300n,      scriptPubKey: spk('aa'), assetTag: coop },              // change to maker (coop)
    { value: 700n,      scriptPubKey: spk('bb'), assetTag: coop },              // fill to taker (coop)
  ],
  ranged: [{
    nIn: 1, payoutAsset: HOST, payoutScript: spk('a2'),
    priceNum: 30000n, priceDen: 1n, changeScript: spk('aa'),
    minFill: 100n, maxFill: 800n, nExpireTime: 0,
  }],
};

const hex = serializeTx(tx);
const back = parseTx(hex);

check('flag bit 8 set (ranged present)', (back.flags & 8) !== 0, 'flags=' + back.flags);
check('round-trip re-serializes identically', serializeTx({ ...back, hasWitness: true }) === hex);

const r = back.ranged[0];
check('ranged count', back.ranged.length === 1);
check('nIn', r.nIn === 1);
check('payoutAsset', r.payoutAsset === HOST);
check('payoutScript', r.payoutScript === spk('a2'));
check('priceNum/priceDen', r.priceNum === 30000n && r.priceDen === 1n);
check('changeScript', r.changeScript === spk('aa'));
check('minFill/maxFill', r.minFill === 100n && r.maxFill === 800n);
check('nExpireTime', r.nExpireTime === 0);

// A user-asset payout tag (not host) must survive too.
const tx2 = { ...tx, ranged: [{ ...tx.ranged[0], payoutAsset: coop, priceNum: 7n, priceDen: 3n, nExpireTime: 4200 }] };
const back2 = parseTx(serializeTx(tx2));
check('non-host payoutAsset survives', back2.ranged[0].payoutAsset === coop);
check('ratio 7/3 survives', back2.ranged[0].priceNum === 7n && back2.ranged[0].priceDen === 3n);
check('nExpireTime 4200 survives', back2.ranged[0].nExpireTime === 4200);

// Without ranged, the flag stays clear (no regression to plain / bundle txs).
const plain = parseTx(serializeTx({ ...tx, ranged: [] }));
check('no ranged ⇒ flag bit 8 clear', (plain.flags & 8) === 0);


// nVersion=3 token (v2) output: a coin parsed from the wire knows only its 32-byte token
// COMMITMENT, not the token list (that lives in the FRT1 reveal). Re-serializing it — which the
// light client does to compute the txid it keys its UTXOs by — MUST reproduce the v2 suffix from
// that commitment. Recomputing from an empty token list emits v1 (tag only), a different
// scriptPubKey, hence a different txid: token coins then land under a ghost outpoint and are
// unspendable (real bug, 2026-07-16).
import { encodeAssetSpk, decodeAssetSpk, tokenSetHash } from '../../../core/asset-spk.mjs';
{
  const base = spk('11');
  const v2 = encodeAssetSpk(base, coop, ['deadbeef', 'cafe']);
  const dec = decodeAssetSpk(v2);
  const rebuilt = encodeAssetSpk(dec.baseSpk, dec.assetTag, [], dec.tokenHash);   // tokens dropped, as after a parse
  check('token v2 spk round-trips from the commitment alone', rebuilt === v2, rebuilt);
  check('commitment matches the token set hash', dec.tokenHash === tokenSetHash(['deadbeef', 'cafe']));
}

finish();
