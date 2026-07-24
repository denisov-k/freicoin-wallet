// harberger-indexer-regtest.mjs — the getharbergernames RPC: authoritative discovery for the covenant
// straight from the consensus name registry (nameHash -> outpoint mirrors the unspent HRBG coins).
//   1. claim two names → both appear with correct namehash/owner/floorV/deposit and a live price;
//   2. filter by namehash → exactly that one;
//   3. forced-buy one → the RPC reflects the new owner + successor outpoint (registry followed the coin).
//   node --import ./apps/web/test/register-aliases.mjs research/harberger-indexer-regtest.mjs
import { execFileSync } from 'node:child_process';
import { serializeTx } from '@core/tx.mjs';
import { pubkeyCompressed } from '@core/ecdsa.mjs';
import { nameHashOf, ownerHashOf, covenantSpk, covenantPrice } from '@core/covenant.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

const CLI = ['/root/fc-nv3-cov/build/bin/freicoin-cli', '-regtest', '-datadir=/root/cov-regtest'];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const cliJSON = (...a) => JSON.parse(cli(...a));
const rev = h => h.match(/../g).reverse().join('');
const addr = () => cli('getnewaddress');
let pass = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (c) pass++; else throw new Error('FAIL: ' + n); };

const OP_TRUE = '51', FLOOR = 1000000, D = 100000000;
const opIn = (t, v) => ({ prevout: { txid: rev(t), vout: v }, scriptSig: '', sequence: 0xffffffff, witness: [] });
const owner = { a: pubkeyCompressed(sha256(Buffer.from('idx-a', 'utf8')).toString('hex')),
                b: pubkeyCompressed(sha256(Buffer.from('idx-b', 'utf8')).toString('hex')),
                c: pubkeyCompressed(sha256(Buffer.from('idx-c', 'utf8')).toString('hex')) };

function freshCoin() {
  const bl = cliJSON('getblock', cliJSON('generateblock', 'raw(51)', '[]').hash);
  cli('generatetoaddress', '100', addr());
  return { txid: bl.tx[0], h: bl.height, val: Math.round(cliJSON('gettxout', bl.tx[0], '0').value * 1e8) };
}
function claim(name, ownerPub) {
  const c = freshCoin();
  const t = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: c.h,
    vin: [opIn(c.txid, 0)], vout: [{ value: BigInt(D), scriptPubKey: covenantSpk(name, ownerPub, FLOOR) }, { value: BigInt(c.val - D - 10000), scriptPubKey: OP_TRUE }] };
  const txid = cliJSON('getblock', cliJSON('generateblock', addr(), JSON.stringify([serializeTx(t)])).hash).tx[1];
  return { txid, refheight: c.h };
}

const A = 'idx-a.frl.' + Date.now(), B = 'idx-b.frl.' + Date.now();
const ca = claim(A, owner.a), cb = claim(B, owner.b);

// 1. both names listed with correct fields
const names = cliJSON('getharbergernames');
const byHash = h => names.find(n => n.namehash === h);
const ea = byHash(nameHashOf(A)), eb = byHash(nameHashOf(B));
ok('both claimed names appear in getharbergernames', !!ea && !!eb);
ok('owner matches the covenant commitment', ea.owner === ownerHashOf(owner.a) && eb.owner === ownerHashOf(owner.b));
ok('floorV + deposit reported', ea.floorV === FLOOR && ea.deposit === D);
ok('outpoint points at the claim tx', ea.outpoint === `${ca.txid}:0`);
const tip = cliJSON('getblockcount');
ok('price == present value at the next block (< deposit as it melts)',
   BigInt(ea.price) === covenantPrice(D, ca.refheight, tip + 1) && BigInt(ea.price) <= BigInt(D));

// 2. filter by namehash → exactly one
const only = cliJSON('getharbergernames', nameHashOf(A));
ok('filtering by namehash returns exactly that name', only.length === 1 && only[0].namehash === nameHashOf(A));

// 3. forced-buy A (sign-free via OP_TRUE funding + generateblock) → RPC reflects the new owner
const fund = freshCoin();
const V = covenantPrice(D, ca.refheight, cliJSON('getblockcount'));   // approx; exact V recomputed at lockHeight below
const L = cliJSON('getblockcount');
const Vexact = covenantPrice(D, ca.refheight, L);
const buy = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: L,
  vin: [opIn(ca.txid, 0), opIn(fund.txid, 0)],
  vout: [{ value: Vexact, scriptPubKey: '0014' + ownerHashOf(owner.a) },
         { value: Vexact, scriptPubKey: covenantSpk(A, owner.c, FLOOR) }] };
const buyTxid = cliJSON('getblock', cliJSON('generateblock', addr(), JSON.stringify([serializeTx(buy)])).hash).tx[1];
const afterBuy = cliJSON('getharbergernames', nameHashOf(A));
ok('after forced buy, the RPC shows the new owner', afterBuy.length === 1 && afterBuy[0].owner === ownerHashOf(owner.c));
ok('and the successor outpoint (registry followed the coin)', afterBuy[0].outpoint === `${buyTxid}:1`);

cli('stop');
console.log(`\n${pass} checks passed — getharbergernames indexer (list, filter, follows forced buy) ✅`);
