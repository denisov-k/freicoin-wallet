// scan.mjs — client-side wallet scan: parse the blocks BIP158 flagged, track the
// wallet's UTXOs, and compute a demurrage present-value balance — no backend.
import { Buffer } from 'buffer';
import { readVarint, skipAuxPow } from './p2p.mjs';
import { parseTx, serializeTx, txid } from '../../../../core/tx.mjs';
import { timeAdjustValue } from '../../../../core/demurrage.mjs';
import { sha256, sha256d, hash160 } from '../../../../core/crypto.mjs';

// nVersion=3: extract asset-definition OP_RETURNs ('FRA1' + canonical def) from a tx list.
// Returns Map assetTag(hex) -> { shift, interest, granularity }. The tag is Hash160(def) BY
// CONSTRUCTION, so the rate is SELF-CERTIFYING: a client keying assets by this map trusts no
// server for an asset's melt/grow rate — the id it trades already commits it.
const ASSET_MAGIC = '46524131';   // 'FRA1' — the canonical asset definition (rate, committed in the tag)
const NAME_MAGIC = '4652414e';    // 'FRAN' — a companion OP_RETURN naming the asset defined in the
                                  // SAME tx. Consensus ignores it (not a valid def); we read it so
                                  // an asset shows a human name from-chain. NOT in the tag, so it is
                                  // an issuer DECLARATION (immutable in its defining block), not a
                                  // rate-style self-certification — a name only mislabels.
// keep printable chars only, drop anything that could break out into HTML, cap length
const cleanName = s => s.replace(/[<>&"'\x00-\x1f\x7f]/g, '').slice(0, 32).trim();
export function extractAssetDefs(txs) {
  const defs = new Map();
  for (const tx of txs) {
    let tag = null, params = null, nameHash = null, name = null;
    for (const o of tx.vout) {
      const spk = o.scriptPubKey;
      if (!spk || !spk.startsWith('6a')) continue;             // OP_RETURN
      const mi = spk.indexOf(ASSET_MAGIC);
      if (mi >= 0) {
        const defHex = spk.slice(mi + 8);
        if (defHex.length < 84) continue;                      // canonical def is >= 42 bytes
        const def = Buffer.from(defHex, 'hex');
        const shift = def[0];
        if (shift < 1 || shift > 64) continue;                 // kernel domain (else not a def)
        let gran = 0n; for (let i = 0; i < 8; i++) gran += BigInt(def[2 + i]) << (8n * BigInt(i));
        tag = Buffer.from(hash160(def)).toString('hex');
        params = { shift, interest: (def[1] & 1) !== 0, granularity: gran || 1n };
        nameHash = def.subarray(10, 42);                       // the market commits sha256(name) here
        continue;
      }
      const ni = spk.indexOf(NAME_MAGIC);
      if (ni >= 0) { try { name = cleanName(Buffer.from(spk.slice(ni + 8), 'hex').toString('utf8')); } catch { /* not a name */ } }
    }
    if (tag && params) {
      // accept the name ONLY if it is self-certified: sha256(name) must equal the 32 bytes the
      // tag commits (def bytes 10..42). So the displayed name is provably the issued one — the
      // relay cannot relabel an asset, only the issuer's original name shows.
      if (name && nameHash && Buffer.from(sha256(Buffer.from(name, 'utf8'))).equals(nameHash)) params.name = name;
      defs.set(tag, params);
    }
  }
  return defs;
}

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
      tx.vout.forEach((o, i) => { if (mine.has(o.scriptPubKey)) utxos.set(id + ':' + i, { value: o.value, refheight: h, script: o.scriptPubKey, assetTag: o.assetTag ?? null, tokens: o.tokens ?? [] }); });
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
