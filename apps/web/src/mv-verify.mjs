// mv-verify.mjs — TRUSTLESS verification of a counterparty's HTLC-funding output before we act on
// it (reveal R by claiming, or lock our own side). The relay reports {txid, vout, value, ...}; we
// DON'T take its word: we fetch the RAW funding tx, recompute its txid (content-addressed — the
// relay can't forge a hex whose hash matches the id we asked for), and read the output ourselves.
// What this closes: a relay that under-reports value (we'd claim less than owed / reveal R cheaply)
// or mislabels an asset tag. What it can't: prove the tx is buried — BTC_MINCONF / the light client
// handle depth. A mismatch throws; the caller must NOT proceed.
import { api } from './mv-ctx.mjs';
import { parseTx, txid as frcTxid } from '@core/tx.mjs';
import { sha256d } from '@core/crypto.mjs';

const HOST_TAG = '00'.repeat(20);
const revHex = h => h.match(/../g).reverse().join('');

// Verify an nv3 FRC/asset HTLC output. `expect` = { txid, vout, spk, minValue, assetTag|null,
// minConf }. minConf>0 asserts the funding is BURIED, not just self-consistent — REQUIRED before
// revealing R (a malicious relay can serve a valid-looking but never-mined tx; content-addressing
// only proves "this hex hashes to the id you gave me", not that it exists on-chain).
// Returns the on-chain value (BigInt) on success; throws on any mismatch.
export async function verifyFrcOutput(expect) {
  const { rawtx, confirmations } = await api('rawFrcTx', { txid: expect.txid });
  if ((confirmations ?? 0) < (expect.minConf ?? 0)) throw new Error('verify: FRC funding not confirmed yet');
  const tx = parseTx(rawtx);
  if (frcTxid(tx) !== expect.txid) throw new Error('verify: FRC txid mismatch (relay served a forged tx)');
  const o = tx.vout[expect.vout];
  if (!o) throw new Error('verify: FRC output missing');
  if (o.scriptPubKey !== expect.spk) throw new Error('verify: FRC output not the HTLC we expect');
  const tag = (o.assetTag && o.assetTag !== HOST_TAG) ? o.assetTag : null;
  if ((expect.assetTag ?? null) !== tag) throw new Error('verify: FRC output asset tag mismatch');
  if (BigInt(o.value) < BigInt(expect.minValue)) throw new Error('verify: FRC output holds less than promised');
  return BigInt(o.value);
}

// --- minimal BTC tx output reader: we only need vout[i].{value, scriptPubKey}, not full parsing ---
function btcOutputs(hex) {
  const b = Buffer.from(hex, 'hex'); let p = 0;
  const u32 = () => { const v = b.readUInt32LE(p); p += 4; return v; };
  const varint = () => { const n = b[p++]; if (n < 0xfd) return n; if (n === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; } if (n === 0xfe) { const v = b.readUInt32LE(p); p += 4; return v; } const v = Number(b.readBigUInt64LE(p)); p += 8; return v; };
  u32();                                        // version
  let segwit = false;
  if (b[p] === 0x00 && b[p + 1] === 0x01) { segwit = true; p += 2; }   // marker+flag
  const nIn = varint();
  for (let i = 0; i < nIn; i++) { p += 36; const s = varint(); p += s; p += 4; }   // prevout+script+sequence
  const nOut = varint();
  const outs = [];
  for (let i = 0; i < nOut; i++) {
    const value = b.readBigUInt64LE(p); p += 8;
    const s = varint(); const spk = b.subarray(p, p + s).toString('hex'); p += s;
    outs.push({ value, scriptPubKey: spk });
  }
  // (we stop before witness/locktime — outputs are all we verify)
  return { outs, segwit };
}
// double-SHA256 of the NO-WITNESS serialization, displayed reversed — recompute to bind the hex to
// the txid. We reserialize outputs-and-inputs minimally by stripping the witness from the raw hex.
function btcTxidOf(hex) {
  const b = Buffer.from(hex, 'hex');
  const seg = b[4] === 0x00 && b[5] === 0x01;
  if (!seg) return revHex(Buffer.from(sha256d(b)).toString('hex'));
  // rebuild without marker/flag + witness: version || inputs || outputs || locktime
  let p = 6; const varint = () => { const n = b[p++]; if (n < 0xfd) return n; if (n === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; } if (n === 0xfe) { const v = b.readUInt32LE(p); p += 4; return v; } const v = Number(b.readBigUInt64LE(p)); p += 8; return v; };
  const nIn = varint(); const inStart = 6;
  for (let i = 0; i < nIn; i++) { p += 36; const s = varint(); p += s; p += 4; }
  const nOut = varint();
  for (let i = 0; i < nOut; i++) { p += 8; const s = varint(); p += s; }
  const outEnd = p;
  // witness stack (one per input) — skip to reach locktime
  for (let i = 0; i < nIn; i++) { const items = varint(); for (let j = 0; j < items; j++) { const s = varint(); p += s; } }
  const locktime = b.subarray(p, p + 4);
  const stripped = Buffer.concat([b.subarray(0, 4), b.subarray(inStart, outEnd), locktime]);
  return revHex(Buffer.from(sha256d(stripped)).toString('hex'));
}

// Verify a BTC HTLC output. `expect` = { txid, vout, spk, minValue(sats), minConf }. minConf>0
// asserts depth — REQUIRED before revealing R (same reasoning as the FRC verifier). Returns value.
export async function verifyBtcOutput(expect) {
  const { rawtx, confirmations } = await api('rawBtcTx', { txid: expect.txid });
  if ((confirmations ?? 0) < (expect.minConf ?? 0)) throw new Error('verify: BTC funding not confirmed yet');
  if (btcTxidOf(rawtx) !== expect.txid) throw new Error('verify: BTC txid mismatch (relay served a forged tx)');
  const { outs } = btcOutputs(rawtx);
  const o = outs[expect.vout];
  if (!o) throw new Error('verify: BTC output missing');
  if (o.scriptPubKey !== expect.spk) throw new Error('verify: BTC output not the HTLC we expect');
  if (o.value < BigInt(expect.minValue)) throw new Error('verify: BTC output holds less than promised');
  return o.value;
}
