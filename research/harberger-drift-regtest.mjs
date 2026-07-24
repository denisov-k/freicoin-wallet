// harberger-drift-regtest.mjs — functional proof of the Gesell AUTO-DRIFT: a Harberger name's
// forced-sale price V = asset_pv(deposit, distance) FALLS as the deposit melts by demurrage, and
// the consensus enforces exactly that — no re-posting, works while the owner is offline. Also an
// end-to-end check that the JS demurrage kernel (core/assets.mjs) matches the C++ (TimeAdjustValueForwardK).
//   1. create a name with deposit D; 2. mine K blocks (the deposit melts);
//   3. force-buy paying V=asset_pv(D,K) < D → ACCEPTED (price dropped);
//   4. force-buy paying V-1 → REJECTED (V is the exact consensus threshold).
// Sign-free (OP_TRUE funding, legacy v2 tx). Run from the wallet repo root:
//   node --import ./apps/web/test/register-aliases.mjs <this file>
import { execFileSync } from 'node:child_process';
import { serializeTx } from '@core/tx.mjs';
import { encodeHarbergerSpk } from '@core/asset-spk.mjs';
import { assetPresentValue } from '@core/assets.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

const CLI = ['/root/fc-nv3-cov/build/bin/freicoin-cli', '-regtest', '-datadir=/root/cov-regtest'];
const cli = (...a) => execFileSync(CLI[0], [...CLI.slice(1), ...a], { encoding: 'utf8' }).trim();
const cliJSON = (...a) => JSON.parse(cli(...a));
const rev = h => h.match(/../g).reverse().join('');
const mineAddr = cli('getnewaddress');

const nameHash = sha256(Buffer.from('drift-' + Date.now(), 'utf8')).toString('hex');
const ownerHex = 'bb'.repeat(20), buyerHex = 'cc'.repeat(20), floorV = 1000000, OP_TRUE = '51';
const D = 100000000;                                  // 1 FRC deposit (nominal)
const K = 3000;                                       // blocks to melt over
const hrbgSpk = encodeHarbergerSpk(nameHash, ownerHex, floorV);
const succSpk = encodeHarbergerSpk(nameHash, buyerHex, floorV);
const ownerSpk = '0014' + ownerHex;
const opIn = (t, v) => ({ prevout: { txid: rev(t), vout: v }, scriptSig: '', sequence: 0xffffffff, witness: [] });
let pass = 0; const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (c) pass++; else throw new Error('FAIL: ' + n); };

function freshCoin() {
  const bh = cliJSON('generateblock', 'raw(51)', '[]').hash; const b = cliJSON('getblock', bh);
  cli('generatetoaddress', '100', mineAddr);
  return { txid: b.tx[0], val: Math.round(cliJSON('gettxout', b.tx[0], '0').value * 1e8), h: b.height };
}
function mine1(txObj) {
  try { const r = cliJSON('generateblock', mineAddr, JSON.stringify([serializeTx(txObj)])); return { ok: true, hash: r.hash }; }
  catch (e) { return { ok: false, err: (e.stderr || e.message || '').toString() }; }
}

// 1. create HRBG(name) with deposit D at height H (its coin refheight = H)
const cH = freshCoin(), cFund = freshCoin();
const H = cH.h;
const create = { version: 2, hasWitness: false, nLockTime: 0, lockHeight: H,
  vin: [opIn(cH.txid, 0)], vout: [{ value: BigInt(D), scriptPubKey: hrbgSpk }, { value: BigInt(cH.val - D - 10000), scriptPubKey: OP_TRUE }] };
const r1 = mine1(create);
ok('HRBG created with deposit D', r1.ok);
const hrbgTxid = cliJSON('getblock', r1.hash).tx.find((_, i) => i > 0);

// 2. melt: advance K blocks
cli('generatetoaddress', String(K), mineAddr);
const distance = cliJSON('getblockcount') - H;

// 3. the drifted price the consensus should charge now
const V = assetPresentValue(BigInt(D), distance, { k: 20, interest: false });
ok(`price drifted below the deposit (V=${V} < D=${D}, distance=${distance})`, V < BigInt(D));

// 4. force-buy UNDERPAYING (V-1) → rejected
const buyLock = H + distance;
const mkBuy = payout => ({ version: 2, hasWitness: false, nLockTime: 0, lockHeight: buyLock,
  vin: [opIn(hrbgTxid, 0), opIn(cFund.txid, 0)],
  vout: [{ value: payout, scriptPubKey: ownerSpk }, { value: V, scriptPubKey: succSpk }] });   // no change → surplus = fee
const rUnder = mine1(mkBuy(V - 1n));
ok('under-paying the drifted price REJECTED', !rUnder.ok && /harberger-unpaid/i.test(rUnder.err || ''));

// 5. force-buy paying exactly V (the drifted price, < D) → accepted → proves consensus V = asset_pv
const rExact = mine1(mkBuy(V));
ok('paying exactly the drifted price V (< D) ACCEPTED', rExact.ok);
if (!rExact.ok) console.log('   err:', (rExact.err || '').replace(/\s+/g, ' ').slice(0, 160));

console.log(`\n${pass} checks passed — Gesell auto-drift enforced by consensus (JS demurrage == C++) ✅`);
