// harberger-withdraw-e2e-regtest.mjs — the OWNER PATH: releasing a name and reclaiming its deposit.
// With no successor, only the owner may spend the HRBG — authorized by co-spending a coin at the
// owner's own address 0014{owner}, whose signature the interpreter verifies (no consensus sig check).
//   1. the owner withdraws: spend the HRBG (anyone-can-spend) + a SIGNED coin at 0014{owner}, no
//      successor → accepted via sendrawtransaction, name freed;
//   2. a non-owner tries the same (no owner input, no successor) → block rejected harberger-no-successor.
//   node --import ./apps/web/test/register-aliases.mjs research/harberger-withdraw-e2e-regtest.mjs
import { execFileSync } from 'node:child_process';
import { serializeTx } from '@core/tx.mjs';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { frcWpkSpk } from '@core/freiland.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '@core/sighash.mjs';
import { covenantSpk, ownerHashOf, covenantPrice } from '@core/covenant.mjs';
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
const opIn = (t, v) => ({ prevout: { txid: rev(t), vout: v }, scriptSig: '', sequence: 0xfffffffd, witness: [] });
const ownerKey = sha256(Buffer.from('withdraw-owner', 'utf8')).toString('hex');
const ownerPub = pubkeyCompressed(ownerKey);
const ownerLeaf = '21' + ownerPub + 'ac';
const ownerSpk = frcWpkSpk(ownerPub);                       // = 0014{owner}, the owner's own address

function freshCoin() {
  const b = cliJSON('getblock', cliJSON('generateblock', 'raw(51)', '[]').hash);
  cli('generatetoaddress', '100', addr());
  return { txid: b.tx[0], h: b.height, val: Math.round(cliJSON('gettxout', b.tx[0], '0').value * 1e8) };
}
function coinWith(spk, value) {
  const c = freshCoin();
  const t = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: c.h,
    vin: [opIn(c.txid, 0)], vout: [{ value: BigInt(value), scriptPubKey: spk }, { value: BigInt(c.val - value - 10000), scriptPubKey: OP_TRUE }] };
  const txid = cliJSON('getblock', cliJSON('generateblock', addr(), JSON.stringify([serializeTx(t)])).hash).tx[1];
  return { txid, vout: 0, refheight: c.h, value };
}

const name = 'withdraw.frl.' + Date.now();
const D = 100000000;
const hrbg = coinWith(covenantSpk(name, ownerPub, 1000000), D);   // owner = ownerHashOf(ownerPub) = ownerSpk.slice(4)
const ownerCoin = coinWith(ownerSpk, 50000000);                   // the owner's auth coin (0014{owner})
const other = coinWith(OP_TRUE, 50000000);                        // a non-owner coin

// 1. owner withdraws — spend HRBG + the owner's SIGNED coin, no successor
const L = cliJSON('getblockcount');
const V = covenantPrice(D, hrbg.refheight, L);
const wd = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L,
  vin: [opIn(hrbg.txid, 0), opIn(ownerCoin.txid, 0)],
  vout: [{ value: V + BigInt(ownerCoin.value) - 200000n, scriptPubKey: ownerSpk, assetTag: '00'.repeat(20) }] };
wd.vin[0].witness = [];
const sh = segwitV0Sighash(wd, 1, ownerLeaf, BigInt(ownerCoin.value), ownerCoin.refheight, SIGHASH_ALL);
wd.vin[1].witness = [signEcdsa(ownerKey, sh) + '01', '00' + ownerLeaf, ''];
let res; try { res = { ok: true, txid: cli('sendrawtransaction', serializeTx(wd), '0') }; }
catch (e) { res = { ok: false, err: (e.stderr || e.message || '').toString().replace(/\s+/g, ' ') }; }
ok('owner withdraw (HRBG + signed owner coin, no successor) ACCEPTED', res.ok);
if (!res.ok) console.log('   err:', res.err.slice(0, 200));
if (res.ok) {
  cliJSON('generateblock', addr(), JSON.stringify([res.txid]));
  ok('the HRBG deposit is spent (name released)', !cli('gettxout', hrbg.txid, '0'));
}

// 2. a non-owner tries a no-successor spend with NO owner input → block rejected (via generateblock,
//    which runs consensus directly, bypassing relay standardness)
const nameHash2 = covenantSpk('other.frl.' + Date.now(), ownerPub, 1000000);
const hrbg2 = coinWith(nameHash2, D);
const L2 = cliJSON('getblockcount');
const V2 = covenantPrice(D, hrbg2.refheight, L2);
const bad = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: L2,
  vin: [opIn(hrbg2.txid, 0), opIn(other.txid, 0)],
  vout: [{ value: V2 + BigInt(other.value) - 200000n, scriptPubKey: OP_TRUE }] };
let bres; try { cliJSON('generateblock', addr(), JSON.stringify([serializeTx(bad)])); bres = { ok: true }; }
catch (e) { bres = { ok: false, err: (e.stderr || e.message || '').toString() }; }
ok('non-owner no-successor spend REJECTED', !bres.ok && /harberger-no-successor/i.test(bres.err || ''));
if (bres.ok) console.log('   BUG: a non-owner freed the name / pocketed the deposit');

cli('stop');
console.log(`\n${pass} checks passed — owner-path withdraw (owner releases, non-owner cannot) ✅`);
