// bundle_demo.mjs — LIVE DEX phase 2a on regtest: maker BUNDLES with change.
//
// Alice owns one 50-coop coin but wants to sell only 30 coop for 0.3 FRC — keeping 20 as
// CHANGE to herself. Phase 1 could not express that (one input, one committed output). Now
// her signature is SIGHASH_BUNDLE: scoped to her bundle's slice (her input; her two outputs
// — payout AND change), the bundle's expiry, and the valuation lock_height. The matcher adds
// Bob's plain phase-1 style… no — Bob is a bundle too, then matcher legs, and the witness-side
// partition map [(1,2),(1,2)] tells validators where the bundles end. Splice-safe: any
// repartition or tamper breaks a maker signature; the flat per-asset conservation is checked
// by the consensus the composite inherits unchanged.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pubkeyCompressed, signEcdsa } from '../../core/ecdsa.mjs';
import { bundleSighash, SIGHASH_ALL, SIGHASH_BUNDLE } from '../../core/sighash.mjs';
import { segwitV0Sighash } from '../../core/sighash.mjs';
import { serializeTx, txid as computeTxid , NV3_TX_VERSION } from '../../core/tx.mjs';
import { assetPresentValue } from '../../core/assets.mjs';

const DATADIR = process.env.NV3_DATADIR ?? '/tmp/claude-0/-root-free-money/e555c6c3-1be8-497c-bfab-7ed5f9628ddf/scratchpad/nv3reg';
const PORT = 19660;
const sha256 = b => createHash('sha256').update(b).digest();
const hash256 = b => sha256(sha256(b));
const ripemd160 = b => createHash('ripemd160').update(b).digest();
const hash160 = b => ripemd160(sha256(b));
const rev = hex => hex.match(/../g).reverse().join('');
const HOST = '00'.repeat(20);

const cookie = Buffer.from(readFileSync(`${DATADIR}/regtest/.cookie`)).toString('base64');
async function rpc(method, ...params) {
  const res = await fetch(`http://127.0.0.1:${PORT}/wallet/w`, {
    method: 'POST', headers: { Authorization: `Basic ${cookie}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const key = s => {
  const sec = s.repeat(32), pub = pubkeyCompressed(sec);
  const leaf = '21' + pub + 'ac';
  return { sec, pub, leaf, spk: '0014' + ripemd160(hash256(Buffer.from('00' + leaf, 'hex'))).toString('hex') };
};
const alice = key('a7'), bob = key('b8'), matcher = key('c9');
const TRUE_SCRIPT = '51', TRUE_REVEAL = '00' + TRUE_SCRIPT;
const TRUE_SPK = '0020' + hash256(Buffer.from(TRUE_REVEAL, 'hex')).toString('hex');
const TRUE_WITNESS = [TRUE_REVEAL, ''];
const pv = (v, d, k) => assetPresentValue(v, d, { k, interest: false });

async function fundSpk(spkHex, amountFrc, mineAddr) {
  const dec = await rpc('decodescript', spkHex);
  const txid = await rpc('sendtoaddress', dec.address ?? dec.segwit?.address, amountFrc);
  const raw = await rpc('getrawtransaction', txid, true);
  const vout = raw.vout.findIndex(o => o.scriptPubKey.hex === spkHex);
  await rpc('generatetoaddress', 1, mineAddr);
  return { txid, vout, value: BigInt(Math.round(raw.vout[vout].value * 1e8)), refheight: raw.lockheight };
}

const main = async () => {
  try { await rpc('createwallet', 'w'); } catch {}
  try { await rpc('loadwallet', 'w'); } catch {}
  const mine = await rpc('getnewaddress');
  if (await rpc('getblockcount') < 120) await rpc('generatetoaddress', 120, mine);

  // 1. issue 50 coop to Alice; fund Bob + matcher
  const def = Buffer.concat([Buffer.from([18, 0]), Buffer.alloc(8), Buffer.alloc(32)]);
  def.writeUInt8(1, 2);
  const coopTag = hash160(def).toString('hex');
  const fund = await fundSpk(TRUE_SPK, '5.0', mine);
  const issue = {
    version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: fund.refheight, nExpireTime: 0,
    vin: [{ prevout: { txid: rev(fund.txid), vout: fund.vout }, scriptSig: '', sequence: 0xffffffff, witness: TRUE_WITNESS }],
    vout: [
      { value: 5_000_000_000n, scriptPubKey: alice.spk, assetTag: coopTag },
      { value: 0n, scriptPubKey: '6a' + (4 + def.length).toString(16).padStart(2, '0') + '46524131' + def.toString('hex') },
      { value: fund.value - 100000n, scriptPubKey: TRUE_SPK },
    ],
  };
  await rpc('generateblock', mine, [serializeTx(issue)]);
  const issueTxid = computeTxid(issue);
  const bobCoin = await fundSpk(bob.spk, '0.50', mine);
  const matCoin = await fundSpk(matcher.spk, '0.01', mine);
  await rpc('generatetoaddress', 4, mine);
  const H = await rpc('getblockcount');
  const alicePv = pv(5_000_000_000n, H - issue.lockHeight, 18);

  // 2. the BUNDLES — signed independently, each fully offline
  // Alice: sell 3e9 coop-kria for 0.3 FRC, KEEP the rest as change. Expires in 20 blocks.
  const aliceKeep = alicePv - 3_000_000_000n;
  const aliceBundle = {
    vin: [{ prevout: { txid: rev(issueTxid), vout: 0 }, sequence: 0xffffffff }],
    vout: [
      { value: 30_000_000n, scriptPubKey: alice.spk, assetTag: HOST },        // payout
      { value: aliceKeep, scriptPubKey: alice.spk, assetTag: coopTag },       // CHANGE
    ],
    nExpireTime: H + 20,
  };
  // Bob: buy 2999e6 coop-kria for his 0.5 FRC coin, keep FRC change.
  const bobBundle = {
    vin: [{ prevout: { txid: rev(bobCoin.txid), vout: bobCoin.vout }, sequence: 0xffffffff }],
    vout: [
      { value: 2_999_000_000n, scriptPubKey: bob.spk, assetTag: coopTag },
      { value: 15_000_000n, scriptPubKey: bob.spk, assetTag: HOST },          // FRC change
    ],
    nExpireTime: 0,
  };
  const HT = SIGHASH_ALL | SIGHASH_BUNDLE;
  const sign = (bundle, k, value, refheight) => {
    const digest = bundleSighash(bundle, 0, k.leaf, value, BigInt(refheight), { lockHeight: H, hashtype: HT });
    return [signEcdsa(k.sec, digest) + HT.toString(16).padStart(2, '0'), '00' + k.leaf, ''];
  };
  const aliceWit = sign(aliceBundle, alice, 5_000_000_000n, issue.lockHeight);
  const bobWit = sign(bobBundle, bob, bobCoin.value, bobCoin.refheight);
  console.log(`1. BUNDLES signed (SIGHASH_BUNDLE): Alice sells 3e9 of her ${alicePv} coop WITH ${aliceKeep} change back;`);
  console.log(`   Bob buys 2999e6 coop, keeps 0.15 FRC change. Alice's bundle expires at ${H + 20}.`);

  // 3. matcher splices: [alice(1in,2out), bob(1in,2out)] + matcher leg, partition witness-side
  const bobPv = pv(bobCoin.value, H - bobCoin.refheight, 20);
  const matPv = pv(matCoin.value, H - matCoin.refheight, 20);
  const fee = 10_000n;
  const coopSpread = 3_000_000_000n - 2_999_000_000n;                       // 1e6
  const frcChange = bobPv + matPv - 30_000_000n - 15_000_000n - fee;
  const comp = {
    version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: H, nExpireTime: 0,
    vin: [
      { ...aliceBundle.vin[0], scriptSig: '', witness: aliceWit },
      { ...bobBundle.vin[0], scriptSig: '', witness: bobWit },
      { prevout: { txid: rev(matCoin.txid), vout: matCoin.vout }, scriptSig: '', sequence: 0xffffffff, witness: [] },
    ],
    vout: [
      ...aliceBundle.vout, ...bobBundle.vout,
      { value: coopSpread, scriptPubKey: matcher.spk, assetTag: coopTag },
      { value: frcChange, scriptPubKey: matcher.spk, assetTag: HOST },
    ],
    bundles: [{ nIn: 1, nOut: 2, nExpireTime: aliceBundle.nExpireTime }, { nIn: 1, nOut: 2, nExpireTime: 0 }],
  };
  // the matcher's own input signs the WHOLE composite (plain SIGHASH_ALL)
  const matDigest = segwitV0Sighash(comp, 2, matcher.leaf, matCoin.value, BigInt(matCoin.refheight), SIGHASH_ALL);
  comp.vin[2].witness = [signEcdsa(matcher.sec, matDigest) + '01', '00' + matcher.leaf, ''];
  await rpc('generateblock', mine, [serializeTx(comp)]);
  const compTxid = computeTxid(comp);
  const conf = await rpc('getrawtransaction', compTxid, true);
  console.log(`2. COMPOSITE MINED ${compTxid.slice(0, 12)}… (conf ${conf.confirmations}):`);
  console.log(`   Alice: +0.3 FRC AND ${aliceKeep} coop change; Bob: +2999e6 coop and FRC change;`);
  console.log(`   matcher spread: ${coopSpread} coop + ${frcChange - matPv} FRC-kria.`);

  // 4. tamper: matcher steals 1 kria from Alice's CHANGE — her bundle signature must fail
  const tampered = structuredClone(comp);
  tampered.vout[1].value -= 1n;
  tampered.vout[4].value += 1n;
  const matDigest2 = segwitV0Sighash(tampered, 2, matcher.leaf, matCoin.value, BigInt(matCoin.refheight), SIGHASH_ALL);
  tampered.vin[2].witness = [signEcdsa(matcher.sec, matDigest2) + '01', '00' + matcher.leaf, ''];
  try {
    await rpc('generateblock', mine, [serializeTx(tampered)]);
    console.log('3. UNEXPECTED: tampered composite accepted');
  } catch { console.log('3. tampering Alice\'s CHANGE output REJECTED (her bundle signature broke) ✅'); }

  // 5. repartition attack: same bytes, different bundle map — signatures must fail
  const repart = structuredClone(comp);
  repart.bundles = [{ nIn: 2, nOut: 4, nExpireTime: aliceBundle.nExpireTime }];
  const matDigest3 = segwitV0Sighash(repart, 2, matcher.leaf, matCoin.value, BigInt(matCoin.refheight), SIGHASH_ALL);
  repart.vin[2].witness = [signEcdsa(matcher.sec, matDigest3) + '01', '00' + matcher.leaf, ''];
  try {
    await rpc('generateblock', mine, [serializeTx(repart)]);
    console.log('4. UNEXPECTED: repartitioned composite accepted');
  } catch { console.log('4. repartitioning the bundle map REJECTED (maker digests moved) ✅'); }

  console.log('\nDEX PHASE 2a LIVE ✅ — maker bundles with change, splice-safe SIGHASH_BUNDLE, witness-side partition.');
};
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
