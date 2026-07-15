// nv3wire.mjs — the NEW (extension-output) wire binding: maps a STANDARD v2 transaction onto the
// abstract nv3 state machine (nv3chain.mjs Nv3State). Where the old binding read a parallel
// version-3 serialization block (hard fork), this one derives everything from fields old nodes
// already accept:
//   - the asset tag comes from the output's scriptPubKey extension push  (asset-spk.mjs);
//   - smart-property tokens are REVEALED in an OP_RETURN ("FRT1") payload in the same tx and
//     checked against the 52-byte ext push's 32-byte token-set commitment;
//   - asset definitions stay in their OP_RETURN ("FRA1") payload as before.
// The binding VALIDATES the commitment↔reveal correspondence; conservation/authorizer/expiry
// rules then run unchanged in Nv3State — the state machine is encoding-agnostic by design.

import { decodeAssetSpk, tokenSetHash } from './asset-spk.mjs';
import { FRC } from './assets.mjs';

const hexToBytes = h => (h.match(/../g) ?? []).map(x => parseInt(x, 16));
const bytesToHex = a => [...a].map(b => b.toString(16).padStart(2, '0')).join('');

export const TOKEN_REVEAL_MAGIC = '46525431';   // "FRT1"

// ---- reveal payload: FRT1 ++ n(varint) ++ n × ( vout(varint) ++ count(varint) ++ count × varbytes ) ----
function pushVarint(a, n) {
  if (n < 0xfd) a.push(n);
  else if (n <= 0xffff) a.push(0xfd, n & 0xff, (n >> 8) & 0xff);
  else a.push(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

/** Serialize the token reveal for every output that carries tokens → OP_RETURN payload hex
 *  (WITHOUT the OP_RETURN/push opcodes — script wrapping is the builder's business). */
export function makeTokenReveal(outputs) {
  const entries = outputs.map((o, i) => [i, o.tokens ?? []]).filter(([, t]) => t.length);
  if (!entries.length) return null;
  const a = [...hexToBytes(TOKEN_REVEAL_MAGIC)];
  pushVarint(a, entries.length);
  for (const [vout, tokens] of entries) {
    pushVarint(a, vout);
    pushVarint(a, tokens.length);
    for (const t of tokens) { const b = hexToBytes(t); pushVarint(a, b.length); a.push(...b); }
  }
  return bytesToHex(a);
}

/** Parse an FRT1 payload → Map(vout → tokens[]). Throws on malformation. */
export function parseTokenReveal(payloadHex) {
  const b = hexToBytes(payloadHex);
  let p = 0;
  const varint = () => { const v = b[p++]; if (v < 0xfd) return v; if (v === 0xfd) { const r = b[p] | (b[p + 1] << 8); p += 2; return r; } const r = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24); p += 4; return r >>> 0; };
  if (bytesToHex(b.slice(0, 4)) !== TOKEN_REVEAL_MAGIC) throw new Error('not a token reveal');
  p = 4;
  const out = new Map();
  const n = varint();
  for (let i = 0; i < n; i++) {
    const vout = varint();
    if (out.has(vout)) throw new Error(`duplicate reveal for output ${vout}`);
    const cnt = varint();
    const toks = [];
    for (let j = 0; j < cnt; j++) { const len = varint(); toks.push(bytesToHex(b.slice(p, p + len))); p += len; }
    out.set(vout, toks);
  }
  if (p !== b.length) throw new Error('trailing bytes in token reveal');
  return out;
}

const isOpReturn = spk => spk.startsWith('6a');
// OP_RETURN <push data>: accept the single-push forms the model uses (direct ≤75, PUSHDATA1)
function opReturnPayload(spk) {
  const b = hexToBytes(spk);
  if (b[0] !== 0x6a) return null;
  if (b[1] >= 1 && b[1] <= 75) return bytesToHex(b.slice(2, 2 + b[1]));
  if (b[1] === 0x4c) return bytesToHex(b.slice(3, 3 + b[2]));
  return null;
}

/** Bind a parsed STANDARD tx to the abstract nv3 form Nv3State.check() consumes.
 *  tx: { txid, lockHeight, inputs:[outpoint], wireOuts:[{value, scriptPubKey}], def?, nExpireTime?, approvals? }
 *  Returns { ok:false, err } on a binding violation (bad commitment/reveal), else
 *  { ok:true, tx: abstractTx } with per-output { assetId, value, scriptPubKey(base), tokens? }. */
export function bindNv3Tx(tx) {
  // collect FRT1 reveals (at most one — canonical form keeps validation deterministic)
  let reveal = new Map();
  let seenReveal = false;
  for (const o of tx.wireOuts) {
    if (!isOpReturn(o.scriptPubKey)) continue;
    const pl = opReturnPayload(o.scriptPubKey);
    if (pl && pl.startsWith(TOKEN_REVEAL_MAGIC)) {
      if (seenReveal) return { ok: false, err: 'multiple token reveals' };
      seenReveal = true;
      try { reveal = parseTokenReveal(pl); } catch (e) { return { ok: false, err: `bad token reveal: ${e.message}` }; }
    }
  }
  const outputs = [];
  for (const [i, o] of tx.wireOuts.entries()) {
    if (isOpReturn(o.scriptPubKey)) {   // data output: host by construction, carries no value semantics beyond FRC
      if (reveal.has(i)) return { ok: false, err: `reveal targets data output ${i}` };
      outputs.push({ assetId: FRC, value: o.value, scriptPubKey: o.scriptPubKey });
      continue;
    }
    const dec = decodeAssetSpk(o.scriptPubKey);
    if (!dec) return { ok: false, err: `output ${i}: unparseable scriptPubKey` };
    const toks = reveal.get(i);
    if (dec.tokenHash) {
      if (!toks) return { ok: false, err: `output ${i}: token commitment without reveal` };
      if (tokenSetHash(toks) !== dec.tokenHash) return { ok: false, err: `output ${i}: token reveal does not match commitment` };
    } else if (toks) {
      return { ok: false, err: `output ${i}: token reveal without commitment` };
    }
    outputs.push({
      assetId: dec.assetTag ?? FRC,
      value: o.value,
      scriptPubKey: dec.baseSpk,          // the SPENDING rules live in the base program
      ...(toks ? { tokens: toks } : {}),
    });
    reveal.delete(i);
  }
  if (reveal.size) return { ok: false, err: `reveal targets nonexistent output(s): ${[...reveal.keys()].join(',')}` };
  return { ok: true, tx: { txid: tx.txid, lockHeight: tx.lockHeight, inputs: tx.inputs, outputs, ...(tx.def ? { def: tx.def } : {}), ...(tx.nExpireTime != null ? { nExpireTime: tx.nExpireTime } : {}), ...(tx.approvals ? { approvals: tx.approvals } : {}) } };
}
