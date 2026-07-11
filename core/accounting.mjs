// accounting.mjs — executable model of the whitepaper's PRIVATE ACCOUNTING SERVERS
// (§2.4/§5.6): unlimited off-chain volume with a verifiable audit log, settling to the public
// chain only at the edges (deposit/withdraw) and between servers (netted). This pins the
// DESIGN as running code; a production server is an ops project, not consensus.
//
// The two ideas that make it Freicoin-honest:
//   1. off-chain balances are held as COIN-SHAPED chunks {assetId, value(nominal), refheight}
//      — the same representation the chain uses — so DEMURRAGE/INTEREST run off-chain by the
//      identical arithmetic (assetPresentValue), and moving value between users conserves
//      nominal-at-refheight exactly. No new monetary math off-chain.
//   2. every state change is an entry in a HASH-CHAINED audit log SIGNED by the operator;
//      a checkpoint commits the full ledger hash. Any client (or auditor) can verify:
//      chain integrity, signatures, and SOLVENCY — per asset, the ledger's total present
//      value must not exceed the on-chain escrow's present value at the same height.
import { assetPresentValue } from './assets.mjs';
import { sha256 } from './crypto.mjs';
import { pubkeyCompressed, signEcdsa, verifyEcdsaPub } from './ecdsa.mjs';

const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const H = s => hex(sha256(new TextEncoder().encode(s)));
const canon = o => JSON.stringify(o, (k, v) => typeof v === 'bigint' ? String(v) + 'n' : v);

export class AccountingServer {
  constructor({ operatorSec, rates }) {
    this.sec = operatorSec;
    this.pub = pubkeyCompressed(operatorSec);
    this.rates = rates;                    // assetId -> {k, interest} (host FRC included)
    this.ledger = new Map();               // user -> [{assetId, value, refheight}]
    this.log = [];                         // hash-chained, operator-signed entries
  }

  _rate(assetId) { const r = this.rates[assetId]; if (!r) throw new Error(`unknown asset ${assetId}`); return r; }
  _pv(chunk, h) { return assetPresentValue(chunk.value, h - chunk.refheight, this._rate(chunk.assetId)); }

  _append(kind, data) {
    const prev = this.log.length ? this.log[this.log.length - 1].hash : '00'.repeat(32);
    const body = canon({ seq: this.log.length, prev, kind, data });
    const hash = H(body);
    const sig = signEcdsa(this.sec, hash);
    this.log.push({ seq: this.log.length, prev, kind, data, hash, sig });
    return this.log[this.log.length - 1];
  }

  /** Credit a user for an on-chain deposit (a tx paying the server's escrow). The chunk
   *  inherits the depositing tx's lock_height as its refheight — melt continues seamlessly. */
  deposit(user, { assetId, value, refheight, txid }) {
    (this.ledger.get(user) ?? this.ledger.set(user, []).get(user)).push({ assetId, value, refheight });
    return this._append('deposit', { user, assetId, value, refheight, txid });
  }

  /** Instant off-chain transfer. Chunks move (and split) at their own refheights, so the
   *  present value of what leaves equals what arrives — demurrage-exact, fee-free. */
  transfer(from, to, assetId, amount, atHeight) {
    const src = this.ledger.get(from) ?? [];
    let need = amount;
    const moved = [];
    for (const c of [...src]) {
      if (need <= 0n) break;
      if (c.assetId !== assetId) continue;
      const pv = this._pv(c, atHeight);
      if (pv <= 0n) continue;
      if (pv <= need) {           // move the whole chunk (refheight travels with it)
        src.splice(src.indexOf(c), 1);
        moved.push(c); need -= pv;
      } else {                    // split: RE-MINT both parts at the transfer height — the
        // exact on-chain semantics (a tx's outputs are fresh at its lock_height), and the
        // only split that is PV-exact: the truncating kernel is not additive across a
        // nominal split at an old refheight.
        src.splice(src.indexOf(c), 1);
        src.push({ assetId, value: pv - need, refheight: atHeight });
        moved.push({ assetId, value: need, refheight: atHeight });
        need = 0n;
      }
    }
    if (need > 0n) throw new Error('insufficient balance');
    const dst = this.ledger.get(to) ?? this.ledger.set(to, []).get(to);
    dst.push(...moved);
    return this._append('transfer', { from, to, assetId, amount, atHeight, chunks: moved.map(c => ({ ...c })) });
  }

  /** Debit a user for an on-chain withdrawal the server pays out of escrow. */
  withdraw(user, assetId, amount, atHeight, txid) {
    // reuse transfer mechanics into a sink
    this.transfer(user, '__out__', assetId, amount, atHeight);
    const sink = this.ledger.get('__out__');
    sink.length = 0;   // the chunks leave the ledger entirely (they exist on chain now)
    return this._append('withdraw', { user, assetId, amount, atHeight, txid });
  }

  /** Commit the full ledger state into the log. */
  checkpoint(atHeight) {
    const flat = [...this.ledger.entries()].filter(([u]) => u !== '__out__')
      .map(([u, cs]) => [u, cs.map(c => ({ ...c }))]).sort();
    return this._append('checkpoint', { atHeight, ledgerHash: H(canon(flat)) });
  }

  /** Total ledger present value per asset (solvency's left-hand side). */
  liabilities(atHeight) {
    const t = new Map();
    for (const [u, cs] of this.ledger) {
      if (u === '__out__') continue;
      for (const c of cs) t.set(c.assetId, (t.get(c.assetId) ?? 0n) + this._pv(c, atHeight));
    }
    return t;
  }
}

/** AUDIT (any client, no trust in the operator): verify the hash chain, every signature, the
 *  latest checkpoint's ledger hash against a claimed ledger, and SOLVENCY against the
 *  on-chain escrow (list of {assetId, value, refheight} the auditor reads from the chain). */
export function audit({ log, operatorPub, ledger, escrowCoins, rates, atHeight }) {
  let prev = '00'.repeat(32);
  for (const e of log) {
    const body = canon({ seq: e.seq, prev, kind: e.kind, data: e.data });
    if (H(body) !== e.hash) return { ok: false, err: `entry ${e.seq}: hash mismatch (log tampered)` };
    if (!verifyEcdsaPub(operatorPub, e.hash, e.sig)) return { ok: false, err: `entry ${e.seq}: bad operator signature` };
    prev = e.hash;
  }
  const cps = log.filter(e => e.kind === 'checkpoint');
  if (cps.length) {
    const flat = [...ledger.entries()].filter(([u]) => u !== '__out__')
      .map(([u, cs]) => [u, cs.map(c => ({ ...c }))]).sort();
    if (H(canon(flat)) !== cps[cps.length - 1].data.ledgerHash)
      return { ok: false, err: 'ledger does not match the last checkpoint' };
  }
  const rate = id => { const r = rates[id]; if (!r) throw new Error(`unknown asset ${id}`); return r; };
  const pv = c => assetPresentValue(c.value, atHeight - c.refheight, rate(c.assetId));
  const owed = new Map(), held = new Map();
  for (const [u, cs] of ledger) { if (u === '__out__') continue; for (const c of cs) owed.set(c.assetId, (owed.get(c.assetId) ?? 0n) + pv(c)); }
  for (const c of escrowCoins) held.set(c.assetId, (held.get(c.assetId) ?? 0n) + pv(c));
  for (const [id, o] of owed) {
    if ((held.get(id) ?? 0n) < o) return { ok: false, err: `INSOLVENT in ${id}: owes ${o}, escrow holds ${held.get(id) ?? 0n}` };
  }
  return { ok: true };
}

/** Cross-server settlement: many off-chain IOUs between two servers net into ONE on-chain
 *  transfer per asset. Returns the net {assetId -> signed amount} A→B (negative = B→A). */
export function netSettlement(ious) {
  const net = new Map();
  for (const { assetId, amount, dir } of ious)
    net.set(assetId, (net.get(assetId) ?? 0n) + (dir === 'AtoB' ? amount : -amount));
  return net;
}
