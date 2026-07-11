// nv3chain.mjs — executable model of the nVersion=3-lite CONSENSUS STATE TRANSITION: a tiny
// UTXO-set machine that mirrors what CheckTxInputs + ConnectBlock must do in the C++ node.
// This pins down the rules the port implements: a Coin carries its asset tag; validation is
// per-asset present-value balance at the tx's lock_height; an asset registry (built from
// asset-definition txs) supplies each asset's rate. No node, no build — the design authority.
//
// A Coin  : { assetId, value (nominal kria), refheight, scriptPubKey, coinbase }
// A tx    : { txid, lockHeight, inputs:[outpoint], outputs:[{assetId,value,scriptPubKey}], def? }
//   `def` present ⇒ an asset-definition (mint) tx: it registers the asset and may create it
//   from nothing; every other asset in the tx must still balance and FRC still pays the fee.
import { FRC, assetIdOf, assetPresentValue } from './assets.mjs';
import { sha256 } from './crypto.mjs';
import { verifyEcdsaPub } from './ecdsa.mjs';

/** Digest an authorizer signs to approve one asset's movement in one tx:
 *  SHA256d( "FRAPPROV" || txid (32 bytes, wire/internal order) || asset tag (20 bytes) ).
 *  Approvals ride OUTSIDE the txid (witness-side in the node), so this is not circular; the
 *  txid already commits to every output, tag, token and the expiry. In the model a txid that
 *  isn't 64 hex chars (tests use names like 'xfer1') is digested as UTF-8 instead. */
export function approvalDigest(txid, tagHex) {
  const txidBytes = /^[0-9a-f]{64}$/i.test(txid)
    ? Uint8Array.from(txid.match(/../g).map(x => parseInt(x, 16))).reverse()   // wire order
    : new TextEncoder().encode(txid);
  const tag = Uint8Array.from(tagHex.match(/../g).map(x => parseInt(x, 16)));
  const pre = new Uint8Array(8 + txidBytes.length + tag.length);
  pre.set(new TextEncoder().encode('FRAPPROV'), 0); pre.set(txidBytes, 8); pre.set(tag, 8 + txidBytes.length);
  const d = sha256(sha256(pre));
  return [...d].map(x => x.toString(16).padStart(2, '0')).join('');
}

const opkey = (txid, vout) => `${txid}:${vout}`;
const groupSum = (items, key, val) => items.reduce((m, x) => (m.set(key(x), (m.get(key(x)) || 0n) + val(x)), m), new Map());

export class Nv3State {
  constructor() {
    this.utxos = new Map();      // outpoint -> Coin
    this.assets = new Map();     // assetId -> { k, interest }
    this.fees = 0n;              // accumulated FRC fees (present value at spend time)
  }

  rate(id, pendingId, pendingDef) {
    if (id === FRC) return { k: 20, interest: false };
    if (id === pendingId) return pendingDef;
    return this.assets.get(id) || null;
  }

  /** Validate a tx against the current UTXO set + asset registry. Returns {ok, fee} or {ok:false, err}.
   *  `atHeight` is the height the tx is being mined at (for nExpireTime); defaults to its lock height. */
  check(tx, atHeight = tx.lockHeight) {
    // nExpireTime: a tx (e.g. an expiring offer) is invalid once the chain passes this height.
    if (tx.nExpireTime != null && atHeight > tx.nExpireTime) return { ok: false, err: 'tx expired' };
    const ins = [];
    for (const op of tx.inputs) {
      const c = this.utxos.get(op);
      if (!c) return { ok: false, err: `input missing or already spent: ${op}` };
      ins.push(c);
    }
    const mintedId = tx.def ? assetIdOf(tx.def) : null;
    // the kernels are only defined for 1 <= k <= 64 (mirrors ParseAssetDefinition in the node)
    if (tx.def && (tx.def.k < 1 || tx.def.k > 64)) return { ok: false, err: 'bad asset shift' };
    if (tx.def && this.assets.has(mintedId)) return { ok: false, err: 'asset already defined' };
    if (tx.def && tx.outputs.every(o => o.assetId !== mintedId)) return { ok: false, err: 'definition mints nothing' };

    // reject unknown assets BEFORE any present-value math (an unknown asset has no rate)
    for (const id of new Set([...ins.map(c => c.assetId), ...tx.outputs.map(o => o.assetId)]))
      if (id !== FRC && id !== mintedId && !this.assets.has(id)) return { ok: false, err: `unknown asset ${id}` };

    // granularity: each output amount must be a whole multiple of its asset's minimum unit
    // (FRC is fully divisible = 1). Checked at the reference height, per the whitepaper.
    const gran = id => id === FRC ? 1n : BigInt((id === mintedId ? tx.def : this.assets.get(id)).granularity || 1);
    for (const o of tx.outputs)
      if (o.value % gran(o.assetId) !== 0n) return { ok: false, err: `asset ${o.assetId} amount not a multiple of granularity` };

    const inByAsset = groupSum(ins, c => c.assetId, c => assetPresentValue(c.value, tx.lockHeight - c.refheight, this.rate(c.assetId, mintedId, tx.def)));
    const outByAsset = groupSum(tx.outputs, o => o.assetId, o => o.value);   // fresh outputs: pv == nominal
    let fee = 0n;
    for (const id of new Set([...inByAsset.keys(), ...outByAsset.keys()])) {
      if (id !== FRC && id !== mintedId && !this.assets.has(id)) return { ok: false, err: `unknown asset ${id}` };
      const inPv = inByAsset.get(id) || 0n, outSum = outByAsset.get(id) || 0n;
      if (id === mintedId) continue;                    // the defined asset is minted from nothing
      if (outSum > inPv) return { ok: false, err: `asset ${id} inflated: out ${outSum} > in ${inPv}` };
      if (id === FRC) fee = inPv - outSum;
      else if (inPv !== outSum) return { ok: false, err: `asset ${id} not conserved: in ${inPv} != out ${outSum}` };
    }

    // Unique tokens (indivisible smart-property bitstrings, per asset): every output token must
    // come from an input of the SAME asset (or be minted by a definition tx), and no token may
    // appear in two outputs. Tokens not re-output are destroyed (allowed). Keyed per asset, so
    // the same bitstring under different assets is a different token.
    const inTok = new Map();     // assetId -> Set(token)
    for (const c of ins) for (const t of (c.tokens || [])) (inTok.get(c.assetId) || inTok.set(c.assetId, new Set()).get(c.assetId)).add(t);
    const seen = new Set();      // `${assetId}:${token}` guards against duplicate output tokens
    for (const o of tx.outputs) for (const t of (o.tokens || [])) {
      const key = `${o.assetId}:${t}`;
      if (seen.has(key)) return { ok: false, err: `token ${t} of ${o.assetId} output twice` };
      seen.add(key);
      const fromInput = inTok.get(o.assetId)?.has(t);
      if (!fromInput && o.assetId !== mintedId) return { ok: false, err: `token ${t} of ${o.assetId} created from nothing` };
    }

    // Authorizers (KYC / whitelisting / restricted stock): if an asset's definition names an
    // authorizer (a 33-byte compressed pubkey), every movement of that asset requires the
    // authorizer's REAL ECDSA signature over approvalDigest(txid, tag) — carried witness-side
    // (tx.approvals = [{assetId, sig}]), so it is outside the txid and not circular. Minting
    // is exempt (the issuer chooses the authorizer in the definition itself).
    for (const id of new Set([...ins.map(c => c.assetId), ...tx.outputs.map(o => o.assetId)])) {
      if (id === FRC || id === mintedId) continue;
      const auth = this.assets.get(id)?.authorizer;
      if (!auth) continue;
      const appr = (tx.approvals || []).find(a => a.assetId === id);
      if (!appr) return { ok: false, err: `asset ${id} requires authorizer approval` };
      if (!verifyEcdsaPub(auth, approvalDigest(tx.txid, id), appr.sig))
        return { ok: false, err: `asset ${id} authorizer signature invalid` };
    }

    return { ok: true, fee };
  }

  /** Validate and apply a tx: register any new asset, spend inputs, create outputs. */
  apply(tx, atHeight = tx.lockHeight) {
    const v = this.check(tx, atHeight);
    if (!v.ok) return v;
    if (tx.def) this.assets.set(assetIdOf(tx.def), { k: tx.def.k, interest: tx.def.interest, granularity: tx.def.granularity, authorizer: tx.def.authorizer });
    for (const op of tx.inputs) this.utxos.delete(op);
    tx.outputs.forEach((o, i) => this.utxos.set(opkey(tx.txid, i), {
      assetId: o.assetId, value: o.value, refheight: tx.lockHeight, scriptPubKey: o.scriptPubKey, coinbase: false,
      ...(o.tokens && o.tokens.length ? { tokens: o.tokens } : {}),
    }));
    this.fees += v.fee;
    return v;
  }

  /** Seed a coinbase-style coin directly (for tests / genesis funding). */
  seed(txid, vout, coin) { this.utxos.set(opkey(txid, vout), { coinbase: false, ...coin }); return opkey(txid, vout); }

  /** Present value of one coin at a height, under its asset's own monetary policy. */
  presentValueOf(coin, height) {
    return assetPresentValue(coin.value, height - coin.refheight, this.rate(coin.assetId));
  }

  /** DEX phase 2a — COMPOSITE transaction: N signed sub-transaction bundles (each a maker's
   *  own inputs + outputs, all-or-nothing, with change!) spliced by a matcher who adds their
   *  own inputs/outputs. Validation: per-bundle expiry (a stale offer only invalidates if
   *  included), then GLOBAL per-asset conservation over the flattened whole — which is
   *  exactly this state machine's ordinary check(), so the composite inherits every rule
   *  (granularity, tokens, authorizers, unknown assets) for free. Minting inside a
   *  composite is out of scope for 2a (a definition tx stays a plain tx).
   *  ctx = { txid, lockHeight, subtxs: [{inputs, outputs, nExpireTime?}], matcher: {inputs, outputs}, approvals? } */
  checkComposite(ctx, atHeight = ctx.lockHeight) {
    for (const [i, sub] of ctx.subtxs.entries()) {
      if (sub.nExpireTime != null && sub.nExpireTime !== 0 && atHeight > sub.nExpireTime)
        return { ok: false, err: `subtx ${i} expired` };
      if (sub.def) return { ok: false, err: 'no minting inside a composite (2a)' };
      if (!sub.inputs?.length || !sub.outputs?.length)
        return { ok: false, err: `subtx ${i} must have inputs and outputs` };
      // the maker signed a valuation height — the composite must ride at exactly that height
      // (else the matcher could re-value every give with the signatures intact)
      if (sub.lockHeight != null && sub.lockHeight !== ctx.lockHeight)
        return { ok: false, err: `subtx ${i} pinned to lockHeight ${sub.lockHeight}, composite has ${ctx.lockHeight}` };
    }
    const seen = new Set();
    const flatIn = [...ctx.subtxs.flatMap(s => s.inputs), ...(ctx.matcher?.inputs ?? [])];
    for (const op of flatIn) { if (seen.has(op)) return { ok: false, err: `duplicate input ${op}` }; seen.add(op); }
    const flat = {
      txid: ctx.txid, lockHeight: ctx.lockHeight, approvals: ctx.approvals,
      inputs: flatIn,
      outputs: [...ctx.subtxs.flatMap(s => s.outputs), ...(ctx.matcher?.outputs ?? [])],
    };
    return this.check(flat, atHeight);
  }

  /** Validate and apply a composite. Output outpoints enumerate bundle-by-bundle, then the
   *  matcher's — the same order the flat serialization would use. */
  applyComposite(ctx, atHeight = ctx.lockHeight) {
    const v = this.checkComposite(ctx, atHeight);
    if (!v.ok) return v;
    const flat = {
      txid: ctx.txid, lockHeight: ctx.lockHeight, approvals: ctx.approvals,
      inputs: [...ctx.subtxs.flatMap(s => s.inputs), ...(ctx.matcher?.inputs ?? [])],
      outputs: [...ctx.subtxs.flatMap(s => s.outputs), ...(ctx.matcher?.outputs ?? [])],
    };
    return this.apply(flat, atHeight);
  }

  /** Total present value of every UTXO of one asset at a given height (for invariant checks). */
  supplyPresentValue(assetId, height) {
    let s = 0n;
    for (const c of this.utxos.values()) if (c.assetId === assetId)
      s += assetPresentValue(c.value, height - c.refheight, this.rate(assetId));
    return s;
  }
}
