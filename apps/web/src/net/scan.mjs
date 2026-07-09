// scan.mjs — client-side wallet scan: parse the blocks BIP158 flagged, track the
// wallet's UTXOs, and compute a demurrage present-value balance — no backend.
import { Buffer } from 'buffer';
import { readVarint, skipAuxPow } from './p2p.mjs';
import { parseTx, serializeTx, txid } from '../../../../core/tx.mjs';
import { timeAdjustValue } from '../../../../core/demurrage.mjs';
import { sha256d } from '../../../../core/crypto.mjs';

/** Display block hash from a full block's bytes (double-SHA256 of the 80-byte base).
 *  The aux-pow flag (bit 1<<23 of nBits) is cleared before hashing, so an aux-pow
 *  block hashes to the same value as its header (parseHeaders does the same). */
export function blockHash(blockBytes) {
  const base = Buffer.from(Buffer.from(blockBytes).subarray(0, 80));
  base.writeUInt32LE((base.readUInt32LE(72) & ~(1 << 23)) >>> 0, 72);
  return Buffer.from(sha256d(base)).reverse().toString('hex');
}

/** Parse a block into its transactions. Handles native-PoW blocks (80-byte header) and
 *  aux-pow blocks (mainnet), whose header carries a merged-mining proof after the base. */
export function parseBlock(bytes) {
  bytes = Buffer.from(bytes);
  let start = 80;
  if ((bytes.readUInt32LE(72) & (1 << 23)) !== 0) start = skipAuxPow(bytes, 80 + 2);   // aux-pow: dummy(0xff)+flags+proof
  let [n, o] = readVarint(bytes, start);       // tx count (after the full header)
  let hex = bytes.subarray(o).toString('hex');
  const txs = [];
  for (let i = 0; i < n; i++) { const tx = parseTx(hex); txs.push(tx); hex = hex.slice(serializeTx(tx).length); }
  return txs;
}

const revHex = h => Buffer.from(h, 'hex').reverse().toString('hex');

/**
 * Walk `blocks` (in height order) and maintain the wallet's UTXO set for
 * `myScripts` (hex scriptPubKeys). `heightOf(blockHashHex)` gives block heights.
 * Returns a Map "txid:vout" -> { value, refheight, script }.
 */
export function scanBlocks(blocks, myScripts, heightOf) {
  const mine = new Set(myScripts);
  const utxos = new Map();
  for (const b of blocks) {
    const h = heightOf(blockHash(b));
    for (const tx of parseBlock(b)) {
      const id = txid(tx);
      for (const vin of tx.vin) utxos.delete(revHex(vin.prevout.txid) + ':' + vin.prevout.vout);   // spends
      tx.vout.forEach((o, i) => { if (mine.has(o.scriptPubKey)) utxos.set(id + ':' + i, { value: o.value, refheight: h, script: o.scriptPubKey }); });
    }
  }
  return utxos;
}

/** Demurrage present-value balance (kria) of a UTXO map, evaluated at tip+1 (as the node does). */
export function presentValueBalance(utxos, tip) {
  let bal = 0n;
  for (const u of utxos.values()) bal += timeAdjustValue(u.value, tip + 1 - u.refheight);
  return bal;
}
