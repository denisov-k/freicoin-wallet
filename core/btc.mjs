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

const OP = { IF: 0x63, ELSE: 0x67, ENDIF: 0x68, DROP: 0x75, SHA256: 0xa8, EQUALVERIFY: 0x88, CHECKSIG: 0xac, CLTV: 0xb1 };
const op = x => x.toString(16).padStart(2, '0');
const push = h => { const n = h.length / 2; if (!n) return '00'; if (n >= 0x4c) throw new Error('push>75B'); return op(n) + h; };
const scriptNum = n => { const b = []; for (let v = n; v > 0; v = Math.floor(v / 256)) b.push(v & 0xff); if (b[b.length - 1] & 0x80) b.push(0); return push(hex(Uint8Array.from(b))); };

/** Bitcoin HTLC witness script: claim with (preimage, claimPub) or refund after cltv. */
export function btcHtlcLeaf({ paymentHash, claimPub, refundPub, cltv }) {
  return op(OP.IF) + op(OP.SHA256) + push(paymentHash) + op(OP.EQUALVERIFY) + push(claimPub)
       + op(OP.ELSE) + scriptNum(cltv) + op(OP.CLTV) + op(OP.DROP) + push(refundPub)   // Bitcoin CLTV: OP_DROP required
       + op(OP.ENDIF) + op(OP.CHECKSIG);
}
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

/** BIP143 sighash (SIGHASH_ALL) — no refheight, no lock_height: pure Bitcoin. */
export function bip143Sighash(tx, inIdx, scriptCodeHex, amountSats) {
  const prevouts = tx.vin.map(i => revHex(i.prevout.txid) + u32(i.prevout.vout)).join('');
  const seqs = tx.vin.map(i => u32(i.sequence)).join('');
  const outs = tx.vout.map(o => u64(o.value) + varstr(o.scriptPubKey)).join('');
  const vin = tx.vin[inIdx];
  const pre = u32(tx.version) + hex(sha256d(bin(prevouts))) + hex(sha256d(bin(seqs)))
    + revHex(vin.prevout.txid) + u32(vin.prevout.vout) + varstr(scriptCodeHex) + u64(amountSats)
    + u32(vin.sequence) + hex(sha256d(bin(outs))) + u32(tx.nLockTime) + u32(1 /* SIGHASH_ALL */);
  return hex(sha256d(bin(pre)));
}

function btcSpend({ prevTxid, vout, valueSats, leafHex, toSpk, key, satisfier, nLockTime = 0, fee = 2000n }) {
  const tx = {
    version: 2, nLockTime,
    vin: [{ prevout: { txid: prevTxid, vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] }],
    vout: [{ value: BigInt(valueSats) - fee, scriptPubKey: toSpk }],
  };
  const sig = signEcdsa(key, bip143Sighash(tx, 0, leafHex, BigInt(valueSats))) + '01';
  tx.vin[0].witness = [sig, ...satisfier, leafHex];             // P2WSH: witness ends with the script itself
  return { rawtx: serializeBtcTx(tx), txid: btcTxid(tx) };
}

/** Claim the BTC HTLC with the preimage (this REVEALS the swap secret on the BTC chain). */
export function btcHtlcClaim({ prevTxid, vout, valueSats, leafHex, preimage, claimKey, toSpk, fee }) {
  return btcSpend({ prevTxid, vout, valueSats, leafHex, toSpk, key: claimKey, satisfier: [preimage, '01'], fee });
}
/** Refund the BTC HTLC after its timeout. */
export function btcHtlcRefund({ prevTxid, vout, valueSats, leafHex, cltv, refundKey, toSpk, fee }) {
  return btcSpend({ prevTxid, vout, valueSats, leafHex, toSpk, key: refundKey, satisfier: [''], nLockTime: cltv, fee });
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
