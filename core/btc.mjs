// btc.mjs — the BITCOIN leg of a cross-chain atomic swap: standard BIP143 transactions,
// classic bech32 (not bech32m) v0 addresses, and the HTLC script in Bitcoin dialect
// (CLTV leaves its argument on the stack — needs OP_DROP; P2WSH program = SHA256(script),
// single hash, unlike Freicoin's MAST HASH256(0x00||script)). Nothing Freicoin-specific
// may leak in here: if bitcoind accepts these transactions they are genuinely
// Bitcoin-consensus-valid. Ported from research/lightning/ln_phase3_btc_swap.py, which
// proved the byte layout against a real bitcoind.
import { sha256, sha256d, hash160 } from './crypto.mjs';
import { signEcdsa, pubkeyCompressed } from './ecdsa.mjs';

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const bin = h => Uint8Array.from((h.match(/../g) || []).map(x => parseInt(x, 16)));
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return hex(b); };
const u64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return hex(b); };
const varint = n => n < 0xfd ? n.toString(16).padStart(2, '0') : 'fd' + u32(n).slice(0, 4);
const varstr = h => varint(h.length / 2) + h;
const revHex = h => h.match(/../g).reverse().join('');

const OP = { IF: 0x63, ELSE: 0x67, ENDIF: 0x68, DROP: 0x75, SHA256: 0xa8, EQUALVERIFY: 0x88, CHECKSIG: 0xac, CHECKSIGVERIFY: 0xad, CLTV: 0xb1 };
const op = x => x.toString(16).padStart(2, '0');
const push = h => { const n = h.length / 2; if (!n) return '00'; if (n >= 0x4c) throw new Error('push>75B'); return op(n) + h; };
const scriptNum = n => { const b = []; for (let v = n; v > 0; v = Math.floor(v / 256)) b.push(v & 0xff); if (b[b.length - 1] & 0x80) b.push(0); return push(hex(Uint8Array.from(b))); };

/** Bitcoin HTLC witness script — THREE spend paths (mirrors the Freicoin leg's leaf):
 *   1. claim   — SHA256(preimage)==H, claimPub signs         (the swap settles, reveals R)
 *   2. timeout — after cltv, refundPub signs                 (unilateral refund, timelocked)
 *   3. coop    — claimPub AND refundPub both sign, ANYTIME   (instant cooperative cancel)
 * The coop branch needs BOTH sigs, so neither party moves funds alone; it just lets the funder
 * reclaim instantly when the counterparty authorizes (e.g. the payer backs out before the other
 * side has locked anything). Bitcoin's CLTV leaves its arg on the stack → OP_DROP required.
 *   IF  SHA256 <H> EQUALVERIFY <claimPub> CHECKSIG
 *   ELSE IF <cltv> CLTV DROP <refundPub> CHECKSIG
 *        ELSE <claimPub> CHECKSIGVERIFY <refundPub> CHECKSIG ENDIF
 *   ENDIF */
export function btcHtlcLeaf({ paymentHash, claimPub, refundPub, cltv }) {
  return op(OP.IF) + op(OP.SHA256) + push(paymentHash) + op(OP.EQUALVERIFY) + push(claimPub) + op(OP.CHECKSIG)
       + op(OP.ELSE)
       +   op(OP.IF) + scriptNum(cltv) + op(OP.CLTV) + op(OP.DROP) + push(refundPub) + op(OP.CHECKSIG)
       +   op(OP.ELSE) + push(claimPub) + op(OP.CHECKSIGVERIFY) + push(refundPub) + op(OP.CHECKSIG)
       +   op(OP.ENDIF)
       + op(OP.ENDIF);
}
// branch selectors (pushed AFTER the sig items, top of stack last): outer IF reads the last push.
const BTC_SEL_CLAIM = '01';               // outer IF true → claim
const BTC_SEL_TIMEOUT = ['01', ''];       // outer false, inner true → timeout (order: inner, outer-top)
const BTC_SEL_COOP = ['', ''];            // outer false, inner false → coop
export const btcHtlcSpk = leafHex => '0020' + hex(sha256(bin(leafHex)));   // P2WSH: single SHA256

// classic bech32 (BIP173, checksum constant 1) — Bitcoin v0 witness addresses
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = vals => { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1;
  for (const v of vals) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]; } return chk; };
const hrpExpand = h => [...[...h].map(c => c.charCodeAt(0) >> 5), 0, ...[...h].map(c => c.charCodeAt(0) & 31)];
const convertBits = (data, from, to) => { let acc = 0, bits = 0; const out = [];
  for (const b of data) { acc = (acc << from) | b; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)); } }
  if (bits) out.push((acc << (to - bits)) & ((1 << to) - 1)); return out; };
export function btcAddress(programHex, hrp = 'bcrt') {
  const data = [0, ...convertBits([...bin(programHex)], 8, 5)];
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;   // ^1 = classic bech32
  const tail = []; for (let i = 0; i < 6; i++) tail.push((chk >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...tail].map(d => CHARSET[d]).join('');
}
export const btcHtlcAddress = (leafHex, hrp = 'bcrt') => btcAddress(hex(sha256(bin(leafHex))), hrp);

// ---- transaction serialization (standard Bitcoin, segwit) ----
function serializeBtcTx(tx, withWitness = true) {
  let s = u32(tx.version);
  const hasW = withWitness && tx.vin.some(i => i.witness?.length);
  if (hasW) s += '0001';
  s += varint(tx.vin.length);
  for (const i of tx.vin) s += revHex(i.prevout.txid) + u32(i.prevout.vout) + varstr(i.scriptSig || '') + u32(i.sequence);
  s += varint(tx.vout.length);
  for (const o of tx.vout) s += u64(o.value) + varstr(o.scriptPubKey);
  if (hasW) for (const i of tx.vin) { const w = i.witness || []; s += varint(w.length); for (const it of w) s += varstr(it); }
  s += u32(tx.nLockTime);
  return s;
}
export const btcTxid = tx => revHex(hex(sha256d(bin(serializeBtcTx(tx, false)))));

const Z32 = '00'.repeat(32);
/** BIP143 sighash. Default hashtype SIGHASH_ALL (0x01). Supports NONE|ANYONECANPAY (0x82) for the
 *  cooperative-cancel authorization: with ACP set, hashPrevouts/hashSequence are zero and only THIS
 *  input is committed; with NONE set, hashOutputs is zero — so the signer authorizes "spend this
 *  coin" without pinning any output (the counterparty completes the tx however they need). */
export function bip143Sighash(tx, inIdx, scriptCodeHex, amountSats, hashtype = 0x01) {
  const acp = (hashtype & 0x80) !== 0, base = hashtype & 0x1f;   // 0x02 = NONE, 0x03 = SINGLE
  const hashPrevouts = acp ? Z32 : hex(sha256d(bin(tx.vin.map(i => revHex(i.prevout.txid) + u32(i.prevout.vout)).join(''))));
  const hashSequence = (acp || base === 0x02 || base === 0x03) ? Z32 : hex(sha256d(bin(tx.vin.map(i => u32(i.sequence)).join(''))));
  const hashOutputs = base === 0x02 ? Z32
    : base === 0x03 ? (tx.vout[inIdx] ? hex(sha256d(bin(u64(tx.vout[inIdx].value) + varstr(tx.vout[inIdx].scriptPubKey)))) : Z32)
    : hex(sha256d(bin(tx.vout.map(o => u64(o.value) + varstr(o.scriptPubKey)).join(''))));
  const vin = tx.vin[inIdx];
  const pre = u32(tx.version) + hashPrevouts + hashSequence
    + revHex(vin.prevout.txid) + u32(vin.prevout.vout) + varstr(scriptCodeHex) + u64(amountSats)
    + u32(vin.sequence) + hashOutputs + u32(tx.nLockTime) + u32(hashtype);
  return hex(sha256d(bin(pre)));
}

const BTC_DUST = 294n;   // P2WPKH dust floor
function btcSpend({ prevTxid, vout, valueSats, leafHex, toSpk, key, satisfier, nLockTime = 0, fee = 2000n }) {
  // CLAMP the fee so the output never goes negative/below dust during a fee spike: a low-feerate
  // (slow) claim that CONFIRMS still beats a tx that can't be built and strands the coin at its
  // timelock. If the coin can't even cover dust, it was never economically spendable.
  const v = BigInt(valueSats); let f = BigInt(fee);
  if (v - f < BTC_DUST) f = v > BTC_DUST ? v - BTC_DUST : 0n;
  const tx = {
    version: 2, nLockTime,
    vin: [{ prevout: { txid: prevTxid, vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] }],
    vout: [{ value: v - f, scriptPubKey: toSpk }],
  };
  const sig = signEcdsa(key, bip143Sighash(tx, 0, leafHex, BigInt(valueSats))) + '01';
  tx.vin[0].witness = [sig, ...satisfier, leafHex];             // P2WSH: witness ends with the script itself
  return { rawtx: serializeBtcTx(tx), txid: btcTxid(tx) };
}

/** Claim the BTC HTLC with the preimage (this REVEALS the swap secret on the BTC chain). */
export function btcHtlcClaim({ prevTxid, vout, valueSats, leafHex, preimage, claimKey, toSpk, fee }) {
  return btcSpend({ prevTxid, vout, valueSats, leafHex, toSpk, key: claimKey, satisfier: [preimage, BTC_SEL_CLAIM], fee });
}
/** Refund the BTC HTLC after its timeout (now a nested branch → two selector items). */
export function btcHtlcRefund({ prevTxid, vout, valueSats, leafHex, cltv, refundKey, toSpk, fee }) {
  return btcSpend({ prevTxid, vout, valueSats, leafHex, toSpk, key: refundKey, satisfier: BTC_SEL_TIMEOUT, nLockTime: cltv, fee });
}

/** COOPERATIVE-CANCEL authorization: the CLAIM-side party (who is NOT reclaiming the coin) signs
 *  the HTLC input with NONE|ANYONECANPAY — committing only that input, not the outputs — so the
 *  funder can build their refund tx freely. One-way "you may take your coin back." Hand it to the
 *  funder via the relay. Returns the sig with its hashtype byte. */
export function btcHtlcCoopSig({ prevTxid, vout, valueSats, leafHex, claimKey }) {
  const ht = 0x82;   // SIGHASH_NONE | SIGHASH_ANYONECANPAY
  const tx = { version: 2, nLockTime: 0,
    vin: [{ prevout: { txid: prevTxid, vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] }], vout: [] };
  return signEcdsa(claimKey, bip143Sighash(tx, 0, leafHex, BigInt(valueSats), ht)) + op(ht);
}
/** The FUNDER completes the cooperative refund: their own SIGHASH_ALL refund sig + the counterparty's
 *  coop sig, via the coop branch (no timelock → instant). Witness order mirrors the FRC leg:
 *  [refundSig(ALL), claimSig(coop), '', '', leaf] → CHECKSIGVERIFY(claimPub) then CHECKSIG(refundPub). */
export function btcHtlcCoopRefund({ prevTxid, vout, valueSats, leafHex, refundKey, otherSig, toSpk, fee }) {
  const v = BigInt(valueSats); let f = BigInt(fee);
  if (v - f < BTC_DUST) f = v > BTC_DUST ? v - BTC_DUST : 0n;   // same fee-spike clamp as btcSpend
  const tx = { version: 2, nLockTime: 0,
    vin: [{ prevout: { txid: prevTxid, vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] }],
    vout: [{ value: v - f, scriptPubKey: toSpk }] };
  const refundSig = signEcdsa(refundKey, bip143Sighash(tx, 0, leafHex, BigInt(valueSats))) + '01';
  tx.vin[0].witness = [refundSig, otherSig, ...BTC_SEL_COOP, leafHex];
  return { rawtx: serializeBtcTx(tx), txid: btcTxid(tx) };
}

// ---- plain wallet account (native SegWit v0, P2WPKH) — the in-wallet BTC balance ----
// The HTLC helpers above cover the swap legs; these cover an ordinary "hold + send BTC"
// account derived from the same seed. scriptCode for a P2WPKH input is the classic
// 0x76a914{20B}88ac (BIP143), NOT the witness program.

/** P2WPKH scriptPubKey / address for a compressed pubkey. */
export const btcP2wpkhSpk = pubHex => '0014' + hex(hash160(bin(pubHex)));
export const btcP2wpkhAddress = (pubHex, hrp = 'bcrt') => btcAddress(hex(hash160(bin(pubHex))), hrp);

/** Decode a bech32(m) segwit address to its scriptPubKey hex; validates the HRP (network). */
export function btcDecodeAddress(addr, hrp = 'bcrt') {
  const s = String(addr).toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1) throw new Error('bad address');
  if (s.slice(0, pos) !== hrp) throw new Error('address is for a different network');
  const REV = {}; [...CHARSET].forEach((c, i) => REV[c] = i);
  const vals = [...s.slice(pos + 1)].map(c => { const v = REV[c]; if (v === undefined) throw new Error('bad address'); return v; });
  if (vals.length < 7) throw new Error('bad address');
  const ver = vals[0], prog5 = vals.slice(1, -6);
  const prog = convertBits(prog5, 5, 8).slice(0, Math.floor(prog5.length * 5 / 8));
  if (prog.length < 2 || prog.length > 40) throw new Error('bad address');
  return (ver === 0 ? '00' : op(0x50 + ver)) + push(hex(Uint8Array.from(prog)));
}

/** Build + sign a plain P2WPKH send. inputs:[{prevTxid,vout,valueSats,key}] (each key spends its
 *  own input), outputs:[{spk,value}] (caller sizes the fee into the outputs). SIGHASH_ALL. */
export function btcP2wpkhSend({ inputs, outputs, nLockTime = 0 }) {
  const tx = {
    version: 2, nLockTime,
    vin: inputs.map(i => ({ prevout: { txid: i.prevTxid, vout: i.vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] })),
    vout: outputs.map(o => ({ value: BigInt(o.value), scriptPubKey: o.spk })),
  };
  inputs.forEach((inp, idx) => {
    const pub = pubkeyCompressed(inp.key);
    const scriptCode = '76a914' + hex(hash160(bin(pub))) + '88ac';   // BIP143 P2WPKH scriptCode
    const sig = signEcdsa(inp.key, bip143Sighash(tx, idx, scriptCode, BigInt(inp.valueSats))) + '01';
    tx.vin[idx].witness = [sig, pub];
  });
  return { rawtx: serializeBtcTx(tx), txid: btcTxid(tx) };
}

// ---- WIF (wallet import format) — the standard single-key export every bitcoin wallet imports.
// base58check( version ++ 32-byte key ++ 0x01 compressed marker ); version 0x80 = mainnet, 0xef = test nets.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function btcWif(privHex, mainnet = false) {
  const payload = Buffer.concat([Buffer.from([mainnet ? 0x80 : 0xef]), Buffer.from(privHex.padStart(64, '0'), 'hex'), Buffer.from([1])]);
  const full = Buffer.concat([payload, Buffer.from(sha256d(payload)).subarray(0, 4)]);
  let n = 0n; for (const b of full) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return s;   // the version byte is non-zero, so no leading-'1' padding case
}
