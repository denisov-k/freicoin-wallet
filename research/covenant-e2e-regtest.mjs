// covenant-e2e-regtest.mjs — end-to-end proof that core/covenant.mjs's builders produce node-accepted
// transactions across the whole covenant lifecycle, each broadcast through the mempool with
// sendrawtransaction (the real relay path, not generateblock):
//   1. CLAIM a free name (owner's signed wpk funding → HRBG deposit output);
//   2. FORCED BUY it from a different party (pay V to the owner, carry V into a successor);
//   3. REVALUE (top up) one's own name via the buy-your-own path.
//   node --import ./apps/web/test/register-aliases.mjs research/covenant-e2e-regtest.mjs
import { execFileSync } from 'node:child_process';
import { serializeTx } from '@core/tx.mjs';
import { pubkeyCompressed } from '@core/ecdsa.mjs';
import { frcWpkSpk } from '@core/freiland.mjs';
import { sha256 } from '@core/crypto.mjs';
import { buildClaim, buildForcedBuy, buildRevalue, covenantSpk, ownerHashOf, readCovenant } from '@core/covenant.mjs';
import { Buffer } from 'buffer';

const CLI = ['/root/fc-nv3-cov/build/bin/freicoin-cli', '-regtest', '-datadir=/root/cov-regtest'];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const cliJSON = (...a) => JSON.parse(cli(...a));
const rev = h => h.match(/../g).reverse().join('');
const addr = () => cli('getnewaddress');
let pass = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (c) pass++; else throw new Error('FAIL: ' + n); };

const OP_TRUE = '51';
const K = s => sha256(Buffer.from(s, 'utf8')).toString('hex');
const key = { alice: K('alice-key'), bob: K('bob-key') };
const pub = { alice: pubkeyCompressed(key.alice), bob: pubkeyCompressed(key.bob) };

function freshCoin() {
  const b = cliJSON('getblock', cliJSON('generateblock', 'raw(51)', '[]').hash);
  cli('generatetoaddress', '100', addr());
  return { txid: b.tx[0], h: b.height, val: Math.round(cliJSON('gettxout', b.tx[0], '0').value * 1e8) };
}
// a confirmed wpk coin the owner of `k` can sign: {txid, vout, value, refheight, key}
function wpkCoin(k, value) {
  const c = freshCoin();
  const t = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: c.h,
    vin: [{ prevout: { txid: rev(c.txid), vout: 0 }, scriptSig: '', sequence: 0xffffffff, witness: [] }],
    vout: [{ value: BigInt(value), scriptPubKey: frcWpkSpk(pubkeyCompressed(k)) }, { value: BigInt(c.val - value - 10000), scriptPubKey: OP_TRUE }] };
  const txid = cliJSON('getblock', cliJSON('generateblock', addr(), JSON.stringify([serializeTx(t)])).hash).tx[1];
  return { txid, vout: 0, value, refheight: c.h, key: k };
}
const tip = () => cliJSON('getblockcount');
// broadcast a {rawtx,txid}, mine it, return the confirmed tx's output n
function relayMine(built) {
  const txid = cli('sendrawtransaction', built.rawtx, '0');
  cliJSON('generateblock', addr(), JSON.stringify([txid]));
  return txid;
}

const name = 'alice.frl.' + Date.now();
const DEP = 100000000, FUND = 400000000, FLOOR = 1000000;

// 1. CLAIM: alice funds a HRBG deposit for the name from her signed wpk coin
const claimTxid = relayMine(buildClaim({ name, ownerPub: pub.alice, floorV: FLOOR, deposit: DEP,
  funding: wpkCoin(key.alice, FUND), changeSpk: frcWpkSpk(pub.alice), lockHeight: tip() }));
ok('CLAIM relayed + mined (name registered via covenant.mjs)', !!claimTxid);
const claimRefh = cliJSON('getrawtransaction', claimTxid, true).lock_height ?? tip();
ok('the created output is a covenant for our name', readCovenant(cliJSON('gettxout', claimTxid, 0).scriptPubKey.hex)?.nameHash === readCovenant(covenantSpk(name, pub.alice, FLOOR)).nameHash);

// 2. FORCED BUY: bob buys alice's name — pays V to alice, becomes the new owner
const hrbg = { txid: claimTxid, vout: 0, value: DEP, refheight: claimRefh };
const buy = buildForcedBuy({ name, hrbg, currentOwner: ownerHashOf(pub.alice), newOwnerPub: pub.bob, floorV: FLOOR,
  funding: wpkCoin(key.bob, FUND), changeSpk: frcWpkSpk(pub.bob), lockHeight: tip() });
const buyTxid = relayMine(buy);
ok('FORCED BUY relayed + mined (bob bought the name)', !!buyTxid);
ok('the old deposit is spent', !cli('gettxout', claimTxid, '0'));
ok('a successor covenant for the same name now exists, owned by bob',
  readCovenant(cliJSON('gettxout', buyTxid, '1').scriptPubKey.hex)?.owner === ownerHashOf(pub.bob));

// 3. REVALUE: bob tops up his own name to a higher self-assessment via buy-your-own
const succRefh = cliJSON('getrawtransaction', buyTxid, true).lock_height ?? tip();
const bobHrbg = { txid: buyTxid, vout: 1, value: Number(buy.price), refheight: succRefh };
const reval = buildRevalue({ name, hrbg: bobHrbg, ownerPub: pub.bob, floorV: FLOOR, newDeposit: 250000000,
  funding: wpkCoin(key.bob, FUND), changeSpk: frcWpkSpk(pub.bob), lockHeight: tip() });
const revalTxid = relayMine(reval);
ok('REVALUE (top-up) relayed + mined', !!revalTxid);
ok('the successor carries the raised deposit', Math.round(cliJSON('gettxout', revalTxid, '1').value * 1e8) === 250000000);

console.log(`\n${pass} checks passed — covenant.mjs builders drive claim → forced buy → revalue end-to-end ✅`);
