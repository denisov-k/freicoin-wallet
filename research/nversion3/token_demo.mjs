// token_demo.mjs — LIVE smart-property tokens on regtest via the TWO-SIDED reveal (Design B).
//
// A token-bearing output commits H(token-set) inside its v2 scriptPubKey suffix (asset-spk.mjs);
// the tokens themselves are never on the wire or in the chainstate — a coin remembers only the
// 32-byte commitment. So a tx that MOVES tokens reveals, in one OP_RETURN "FRT1" payload:
//   - an OUTPUT section: the token set of each committed output (checked vs its spk commitment);
//   - an INPUT  section: the token set of each committed coin it SPENDS (checked vs that coin's
//                        stored commitment) — the input half, needed because conservation
//                        (output tokens ⊆ input tokens) can't be decided from hashes alone.
// This drives the real node (CheckTxInputs) at BLOCK level and shows: (1) mint, (2) a two-sided
// transfer that splits a token set across two owners, (3) the input/forge negatives are rejected.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pubkeyCompressed, signEcdsa } from '../../core/ecdsa.mjs';
import { segwitV0Sighash, SIGHASH_ALL } from '../../core/sighash.mjs';
import { serializeTx, txid as computeTxid } from '../../core/tx.mjs';
import { encodeAssetSpk, tokenSetHash } from '../../core/asset-spk.mjs';
import { makeTokenReveal } from '../../core/nv3wire.mjs';
import { assetPresentValue } from '../../core/assets.mjs';

const DATADIR = process.env.NV3_DATADIR ?? '/root/nv3-playground/chain';
const PORT = process.env.NV3_RPCPORT ?? 19660;
const cookie = Buffer.from(readFileSync(`${DATADIR}/regtest/.cookie`)).toString('base64');
const sha256 = b => createHash('sha256').update(b).digest();
const hash256 = b => sha256(sha256(b));
const ripemd160 = b => createHash('ripemd160').update(b).digest();
const rev = h => Buffer.from(h, 'hex').reverse().toString('hex');

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
const alice = key('a7'), bob = key('b8');
const TRUE_REVEAL = '00' + '51', TRUE_SPK = '0020' + hash256(Buffer.from(TRUE_REVEAL, 'hex')).toString('hex');
const TRUE_WITNESS = [TRUE_REVEAL, ''];
const opret = payloadHex => '6a' + (payloadHex.length / 2).toString(16).padStart(2, '0') + payloadHex;
const pv = (v, d, k) => assetPresentValue(v, d, { k, interest: false });

async function fundSpk(spkHex, amountFrc, mineAddr) {
  const dec = await rpc('decodescript', spkHex);
  const txid = await rpc('sendtoaddress', dec.address ?? dec.segwit?.address, amountFrc);
  const raw = await rpc('getrawtransaction', txid, true);
  const vout = raw.vout.findIndex(o => o.scriptPubKey.hex === spkHex);
  await rpc('generatetoaddress', 1, mineAddr);
  return { txid, vout, value: BigInt(Math.round(raw.vout[vout].value * 1e8)), refheight: raw.lockheight };
}
// nV3 txs are non-standard for the mempool, so consensus runs at BLOCK level.
const mineOrReason = async (tx, mine) => {
  try { await rpc('generateblock', mine, [serializeTx(tx)]); return null; }
  catch (e) { return e.message; }
};
// sign a P2WPKH-leaf input in place
const signInput = (tx, i, k, value, refheight) => {
  const dg = segwitV0Sighash(tx, i, k.leaf, value, BigInt(refheight), SIGHASH_ALL);
  tx.vin[i].witness = [signEcdsa(k.sec, dg) + '01', '00' + k.leaf, ''];
};

const SHIFT = 20;                            // host-like: demurrage rounds to 0 over a few blocks
const tokX = 'ab01', tokY = 'ab02', tokZ = 'cc99';

const main = async () => {
  try { await rpc('createwallet', 'w'); } catch {}
  try { await rpc('loadwallet', 'w'); } catch {}
  const mine = await rpc('getnewaddress');
  if (await rpc('getblockcount') < 120) await rpc('generatetoaddress', 120, mine);

  // 1. MINT an asset to Alice carrying two smart-property tokens (X, Y). The mint output commits
  //    H([X,Y]) in its v2 spk; the FRT1 output-section reveals them. Minting needs no input reveal.
  const nonce = await rpc('getblockcount');              // unique asset per run ⇒ re-runnable
  const def = Buffer.concat([Buffer.from([SHIFT, 0]), Buffer.alloc(8), sha256(Buffer.from('DEMOTOK' + nonce))]);
  def.writeUInt8(1, 2);                                   // granularity = 1
  const tag = ripemd160(sha256(def)).toString('hex');
  const fund = await fundSpk(TRUE_SPK, '5.0', mine);
  const mintVout = [
    { value: 1000n, scriptPubKey: alice.spk, assetTag: tag, tokens: [tokX, tokY] },   // 0: v2 asset+tokens
    { value: 0n, scriptPubKey: opret('46524131' + def.toString('hex')) },             // 1: FRA1 definition
    { value: fund.value - 100000n, scriptPubKey: TRUE_SPK },                          // 2: FRC change
  ];
  mintVout.push({ value: 0n, scriptPubKey: opret(makeTokenReveal(mintVout, [])) });   // 3: FRT1 (out section)
  const mint = {
    version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: fund.refheight, nExpireTime: 0,
    vin: [{ prevout: { txid: rev(fund.txid), vout: fund.vout }, scriptSig: '', sequence: 0xffffffff, witness: TRUE_WITNESS }],
    vout: mintVout,
  };
  const mreason = await mineOrReason(mint, mine);
  console.log(`1. MINT ${mreason === null ? 'accepted ✅' : `REJECTED ❌ (${mreason})`}`);
  const mintTxid = computeTxid(mint);
  const mintRef = mint.lockHeight;

  // verify on-chain the mint output is a v2 token commitment
  const raw = await rpc('getrawtransaction', mintTxid, true);
  const spk0 = raw.vout[0].scriptPubKey.hex;
  const expect = encodeAssetSpk(alice.spk, tag, [tokX, tokY]);
  console.log(`   mint output spk is v2 (base+tag+H(tokens)+OP_2): ${spk0 === expect ? '✅' : '❌ ' + spk0}`);

  await rpc('generatetoaddress', 2, mine);
  const H = await rpc('getblockcount');
  const givePv = pv(1000n, H - mintRef, SHIFT);

  // 2. TWO-SIDED TRANSFER: spend Alice's token coin. Bob gets 400 units + token X; Alice keeps the
  //    rest + token Y. The FRT1 reveals BOTH the outputs' token sets AND the spent coin's set.
  const buildTransfer = (inReveal, outTokens0, outTokens1) => {
    const bobAmt = 400n, aliceAmt = givePv - bobAmt;
    const vout = [
      { value: bobAmt, scriptPubKey: bob.spk, assetTag: tag, tokens: outTokens0 },     // 0: token X → Bob
      { value: aliceAmt, scriptPubKey: alice.spk, assetTag: tag, tokens: outTokens1 },  // 1: token Y → Alice
    ];
    const reveal = makeTokenReveal(vout, inReveal);                                     // 2: FRT1 (out+in)
    vout.push({ value: 0n, scriptPubKey: opret(reveal) });
    const tx = {
      version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: H, nExpireTime: 0,
      vin: [{ prevout: { txid: rev(mintTxid), vout: 0 }, scriptSig: '', sequence: 0xffffffff, witness: [] }],
      vout,
    };
    signInput(tx, 0, alice, 1000n, mintRef);
    return tx;
  };

  const good = buildTransfer([{ tokens: [tokX, tokY] }], [tokX], [tokY]);
  const greason = await mineOrReason(good, mine);
  console.log(`2. TWO-SIDED TRANSFER (Bob←X, Alice←Y) ${greason === null ? 'accepted ✅' : `REJECTED ❌ (${greason})`}`);

  // 3. negatives — attack the real token coin Bob now holds (transfer output 0: 400 units, token X).
  //    Both are rejected BEFORE spending it, so the same coin serves both attacks.
  const attack = async (label, tx, code) => {
    const reason = await mineOrReason(tx, mine);
    console.log(`3.${label} ${reason === null ? 'UNEXPECTED ACCEPT ❌' : reason.includes(code) ? `REJECTED (…${code}) ✅` : `rejected, wrong reason: ${reason} ❌`}`);
  };
  const transferTxid = computeTxid(good);
  const buildSpendBob = (inReveal, outTokens) => {           // spends transferTxid:0 (Bob's token-X coin)
    const vout = [{ value: 400n, scriptPubKey: alice.spk, assetTag: tag, tokens: outTokens }];
    vout.push({ value: 0n, scriptPubKey: opret(makeTokenReveal(vout, inReveal)) });
    const tx = { version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: H, nExpireTime: 0,
      vin: [{ prevout: { txid: rev(transferTxid), vout: 0 }, scriptSig: '', sequence: 0xffffffff, witness: [] }], vout };
    signInput(tx, 0, bob, 400n, H);                          // Bob's coin, refheight = the transfer's lock height
    return tx;
  };
  await attack('a input commitment without reveal', buildSpendBob([], [tokX]), 'token-input-unrevealed');
  await attack('b forge a token never held', buildSpendBob([{ tokens: [tokX] }], [tokZ]), 'token-created');

  console.log('\nTOKENS LIVE ✅ — two-sided reveal: mint, split-transfer, input/forge rejects.');
};
main().catch(e => { console.error(e); process.exit(1); });
