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

// ---- reveal payload (TWO-SIDED): FRT1 ++ <output section> ++ <input section>, each section:
//        n(varint) ++ n × ( index(varint) ++ count(varint) ++ count × varbytes )
// The OUTPUT section reveals tokens for this tx's committed outputs (checked vs each output spk's
// commitment here in the binding). The INPUT section reveals the token sets of the committed coins
// being SPENT — checked in Nv3State.check against each spent coin's stored commitment, since the
// chainstate keeps only the 32-byte hash, never the token list. Both halves are needed because
// conservation (output tokens ⊆ input tokens) can't be decided from commitments alone.
function pushVarint(a, n) {
  if (n < 0xfd) a.push(n);
  else if (n <= 0xffff) a.push(0xfd, n & 0xff, (n >> 8) & 0xff);
  else a.push(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}
function pushSection(a, entries) {
  pushVarint(a, entries.length);
  for (const [idx, tokens] of entries) {
    pushVarint(a, idx);
    pushVarint(a, tokens.length);
    for (const t of tokens) { const b = hexToBytes(t); pushVarint(a, b.length); a.push(...b); }
  }
}

/** Serialize the two-sided token reveal → OP_RETURN payload hex (WITHOUT the OP_RETURN/push
 *  opcodes — script wrapping is the builder's business). `outputs` and `inputs` are arrays
 *  parallel to the tx's vout / vin; only entries whose `.tokens` is non-empty are serialized.
 *  Returns null when nothing needs revealing. */
export function makeTokenReveal(outputs, inputs = []) {
  const outEntries = outputs.map((o, i) => [i, o?.tokens ?? []]).filter(([, t]) => t.length);
  const inEntries  = inputs.map((o, i) => [i, o?.tokens ?? []]).filter(([, t]) => t.length);
  if (!outEntries.length && !inEntries.length) return null;
  const a = [...hexToBytes(TOKEN_REVEAL_MAGIC)];
  pushSection(a, outEntries);
  pushSection(a, inEntries);
  return bytesToHex(a);
}


/** Build an OP_RETURN script for a payload: direct push (≤75), PUSHDATA1 (76–255) or PUSHDATA2
 *  (256–65535, little-endian length). The old inline builders emitted a bogus PUSHDATA1 byte for
 *  n>255 → a malformed script → a token coin with many/long tokens was unspendable. */
export function opReturnScript(payloadHex) {
  const n = payloadHex.length / 2;
  let push;
  if (n <= 75) push = n.toString(16).padStart(2, '0');
  else if (n <= 255) push = '4c' + n.toString(16).padStart(2, '0');
  else if (n <= 65535) push = '4d' + (n & 0xff).toString(16).padStart(2, '0') + ((n >> 8) & 0xff).toString(16).padStart(2, '0');
  else throw new Error('OP_RETURN payload too large');
  return '6a' + push + payloadHex;
}

/** Parse an FRT1 payload → { outputs: Map(vout→tokens[]), inputs: Map(vin→tokens[]) }. Throws on
 *  malformation. */
export function parseTokenReveal(payloadHex) {
  const b = hexToBytes(payloadHex);
  let p = 0;
  // canonical compactSize only — the C++ side (ReadCompactSize) rejects a value that fits a
  // shorter form, so a parser that accepts it would disagree with consensus about the payload
  const varint = () => {
    const v = b[p++]; if (v < 0xfd) return v;
    if (v === 0xfd) { const r = b[p] | (b[p + 1] << 8); p += 2; if (r < 0xfd) throw new Error('non-canonical compactSize'); return r; }
    const r = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; p += 4;
    if (v !== 0xfe) throw new Error('unsupported compactSize');   // 8-byte sizes can't occur in a reveal
    if (r < 0x10000) throw new Error('non-canonical compactSize');
    return r;
  };
  if (bytesToHex(b.slice(0, 4)) !== TOKEN_REVEAL_MAGIC) throw new Error('not a token reveal');
  p = 4;
  const section = label => {
    const m = new Map();
    const n = varint();
    for (let i = 0; i < n; i++) {
      const idx = varint();
      if (m.has(idx)) throw new Error(`duplicate reveal for ${label} ${idx}`);
      const cnt = varint();
      const toks = [];
      for (let j = 0; j < cnt; j++) { const len = varint(); if (p + len > b.length) throw new Error('reveal runs past payload'); toks.push(bytesToHex(b.slice(p, p + len))); p += len; }
      m.set(idx, toks);
    }
    return m;
  };
  const outputs = section('output');
  const inputs = section('input');
  if (p !== b.length) throw new Error('trailing bytes in token reveal');
  return { outputs, inputs };
}

const isOpReturn = spk => spk.startsWith('6a');
// OP_RETURN <push data>: accept the single-push forms the model uses (direct ≤75, PUSHDATA1)
function opReturnPayload(spk) {
  const b = hexToBytes(spk);
  if (b[0] !== 0x6a) return null;
  if (b[1] >= 1 && b[1] <= 75) return bytesToHex(b.slice(2, 2 + b[1]));
  if (b[1] === 0x4c) return bytesToHex(b.slice(3, 3 + b[2]));                        // PUSHDATA1
  if (b[1] === 0x4d) return bytesToHex(b.slice(4, 4 + (b[2] | (b[3] << 8))));         // PUSHDATA2 (LE)
  if (b[1] === 0x4e) return bytesToHex(b.slice(6, 6 + (b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24)))); // PUSHDATA4
  return null;
}

/** Bind a parsed STANDARD tx to the abstract nv3 form Nv3State.check() consumes.
 *  tx: { txid, lockHeight, inputs:[outpoint], wireOuts:[{value, scriptPubKey}], def?, nExpireTime?, approvals? }
 *  Returns { ok:false, err } on a binding violation (bad commitment/reveal), else
 *  { ok:true, tx: abstractTx } with per-output { assetId, value, scriptPubKey(base), tokens? }. */
export function bindNv3Tx(tx) {
  // collect the FRT1 reveal (at most one — canonical form keeps validation deterministic)
  let outReveal = new Map(), inReveal = new Map();
  let seenReveal = false;
  for (const o of tx.wireOuts) {
    if (!isOpReturn(o.scriptPubKey)) continue;
    const pl = opReturnPayload(o.scriptPubKey);
    if (pl && pl.startsWith(TOKEN_REVEAL_MAGIC)) {
      if (seenReveal) return { ok: false, err: 'multiple token reveals' };
      seenReveal = true;
      try { const r = parseTokenReveal(pl); outReveal = r.outputs; inReveal = r.inputs; }
      catch (e) { return { ok: false, err: `bad token reveal: ${e.message}` }; }
    }
  }
  // input reveals must target real inputs (their commitment match is decided in Nv3State.check,
  // which has the spent coins; the binding only validates structure and attaches them).
  for (const j of inReveal.keys()) if (j >= tx.inputs.length) return { ok: false, err: `token reveal targets nonexistent input ${j}` };
  const outputs = [];
  for (const [i, o] of tx.wireOuts.entries()) {
    if (isOpReturn(o.scriptPubKey)) {   // data output: host by construction, carries no value semantics beyond FRC
      if (outReveal.has(i)) return { ok: false, err: `reveal targets data output ${i}` };
      outputs.push({ assetId: FRC, value: o.value, scriptPubKey: o.scriptPubKey });
      continue;
    }
    const dec = decodeAssetSpk(o.scriptPubKey);
    if (!dec) return { ok: false, err: `output ${i}: unparseable scriptPubKey` };
    const toks = outReveal.get(i);
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
      ...(dec.tokenHash ? { tokenCommit: dec.tokenHash } : {}),   // stored on the coin for a future spend
      ...(toks ? { tokens: toks } : {}),                          // this tx's output tokens (for conservation)
    });
    outReveal.delete(i);
  }
  if (outReveal.size) return { ok: false, err: `reveal targets nonexistent output(s): ${[...outReveal.keys()].join(',')}` };
  // attach the revealed input token sets parallel to tx.inputs; Nv3State.check verifies each
  // against the spent coin's stored commitment (the input half of the two-sided reveal).
  const inputReveals = tx.inputs.map((_, j) => inReveal.get(j));
  return { ok: true, tx: { txid: tx.txid, lockHeight: tx.lockHeight, inputs: tx.inputs, inputReveals, outputs, ...(tx.def ? { def: tx.def } : {}), ...(tx.nExpireTime != null ? { nExpireTime: tx.nExpireTime } : {}), ...(tx.approvals ? { approvals: tx.approvals } : {}) } };
}
