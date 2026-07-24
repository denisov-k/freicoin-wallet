// harberger-forcedbuy-e2e-regtest.mjs — the piece the relay test couldn't reach: a VALID forced buy,
// with a real WALLET-SIGNED funding input, broadcast through the mempool with sendrawtransaction.
// This dispels the "signing blocker": the wallet's Freicoin MAST-v0 wpk spend (core/htlc.mjs pattern:
// witness = [sig, '00'+leaf, ''], scriptCode = the P2PK leaf) is accepted by the node exactly like
// swap.test.mjs proves for HTLC legs. The buyer brings V (signed), pays the owner, carries the deposit
// into a successor for the same name → the covenant's forced sale, end to end over the relay path.
//   node --import ./apps/web/test/register-aliases.mjs research/harberger-forcedbuy-e2e-regtest.mjs
import { execFileSync } from 'node:child_process';
import { serializeTx } from '@core/tx.mjs';
import { encodeHarbergerSpk } from '@core/asset-spk.mjs';
import { frcWpkSpk } from '@core/freiland.mjs';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '@core/sighash.mjs';
import { assetPresentValue } from '@core/assets.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

const CLI = ['/root/fc-nv3-cov/build/bin/freicoin-cli', '-regtest', '-datadir=/root/cov-regtest'];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const cliJSON = (...a) => JSON.parse(cli(...a));
const rev = h => h.match(/../g).reverse().join('');
const addr = () => cli('getnewaddress');
let pass = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (c) pass++; else throw new Error('FAIL: ' + n); };

const OP_TRUE = '51';
const opIn = (txid, vout) => ({ prevout: { txid: rev(txid), vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] });

// the buyer's seed-derived key → its Freicoin MAST-v0 wpk (deposit) script + P2PK leaf
const buyerKey = sha256(Buffer.from('forcedbuy-buyer', 'utf8')).toString('hex');
const buyerPub = pubkeyCompressed(buyerKey);
const buyerLeaf = '21' + buyerPub + 'ac';
const buyerSpk = frcWpkSpk(buyerPub);

function freshCoin() {
  const b = cliJSON('getblock', cliJSON('generateblock', 'raw(51)', '[]').hash);
  cli('generatetoaddress', '100', addr());
  return { txid: b.tx[0], h: b.height, val: Math.round(cliJSON('gettxout', b.tx[0], '0').value * 1e8) };
}
// create a CONFIRMED output {spk, value} via a regular tx (refheight = the tx's lock_height)
function coinWith(spk, value) {
  const c = freshCoin();
  const t = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: c.h,
    vin: [opIn(c.txid, 0)], vout: [{ value: BigInt(value), scriptPubKey: spk }, { value: BigInt(c.val - value - 10000), scriptPubKey: OP_TRUE }] };
  const txid = cliJSON('getblock', cliJSON('generateblock', addr(), JSON.stringify([serializeTx(t)])).hash).tx[1];
  return { txid, vout: 0, refheight: c.h, value };
}

// 1. a live name: HRBG(name, owner) with deposit D
const nameHash = sha256(Buffer.from('fb-' + Date.now(), 'utf8')).toString('hex');
const ownerHash = 'bb'.repeat(20), newOwner = 'cc'.repeat(20), D = 100000000, FUND = 300000000;
const hrbg = coinWith(encodeHarbergerSpk(nameHash, ownerHash, 1000000), D);
// 2. the buyer's funding coin, on the buyer's own wpk (spent with a real signature below)
const fund = coinWith(buyerSpk, FUND);

// 3. the forced buy at the current tip: pay V to the owner, carry V into a successor for the name
const lockHeight = cliJSON('getblockcount');
const V = assetPresentValue(BigInt(D), lockHeight - hrbg.refheight, { k: 20, interest: false });
const FEE = 500000n;
const change = BigInt(FUND) - V - FEE;                       // < fund present value ⇒ out < in (rest = fee)
const tx = {
  version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight,
  vin: [opIn(hrbg.txid, hrbg.vout), opIn(fund.txid, fund.vout)],   // [HRBG anyone-can-spend, buyer funding]
  vout: [
    { value: V, scriptPubKey: '0014' + ownerHash },                       // (1) pay the current owner V
    { value: V, scriptPubKey: encodeHarbergerSpk(nameHash, newOwner, 1000000) }, // (2) successor for the name
    { value: change, scriptPubKey: buyerSpk },                            // buyer's change
  ],
};
// vin[0] (HRBG) is anyone-can-spend → empty witness; vin[1] (buyer wpk) gets a real MAST-v0 signature
tx.vin[0].witness = [];
const sh = segwitV0Sighash(tx, 1, buyerLeaf, BigInt(FUND), fund.refheight, SIGHASH_ALL);
tx.vin[1].witness = [signEcdsa(buyerKey, sh) + '01', '00' + buyerLeaf, ''];

let res;
try { res = { ok: true, txid: cli('sendrawtransaction', serializeTx(tx), '0') }; }   // maxfeerate 0 = no absurd-fee cap
catch (e) { res = { ok: false, err: (e.stderr || e.message || '').toString().replace(/\s+/g, ' ') }; }
ok('valid forced buy with a wallet-SIGNED funding input ACCEPTED by sendrawtransaction', res.ok);
if (!res.ok) { console.log('   err:', res.err.slice(0, 200)); }
else {
  ok('the forced buy is in the mempool', cliJSON('getrawmempool').includes(res.txid));
  const mined = cliJSON('generateblock', addr(), JSON.stringify([res.txid])).hash;   // mines it into a block
  ok('it confirms in a block (spends the HRBG, creates the successor)', cliJSON('getblock', mined).tx.includes(res.txid));
  ok('the old HRBG deposit is spent', !cli('gettxout', hrbg.txid, '0'));
}

console.log(`\n${pass} checks passed — valid forced buy broadcast end-to-end with a signed funding input ✅`);
