// market-server.mjs — the Freimarkets MARKET backend for real (non-custodial) users.
// The browser holds the keys (the wallet's own vault); this server only:
//   - runs the experimental chain (-nv3assets) and mines a block every N seconds,
//   - indexes the chain (spk -> utxos with asset tags; OP_RETURN defs -> asset registry),
//   - hands out faucet FRC, funds+mines asset issuances (OP_TRUE leg, mint to the user),
//   - relays user-signed transactions into blocks,
//   - keeps the shared ORDER BOOK of user-signed SIGHASH_SINGLE|ANYONECANPAY offers and
//     auto-matches crosses, taking the fee from its own wallet (spread stays with makers'
//     pricing; the house takes only what the offers leave).
// It can steal nothing: every asset movement carries a user signature the chain verifies.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { serializeTx, parseTx, txid as computeTxid, NV3_TX_VERSION } from '../../core/tx.mjs';
import { assetPresentValue } from '../../core/assets.mjs';
import { pubkeyCompressed, signEcdsa } from '../../core/ecdsa.mjs';
import { frcLeg, claimReceived } from '../../core/swap.mjs';
import { htlcSpk, htlcLeaf } from '../../core/htlc.mjs';
import { btcHtlcLeaf, btcHtlcSpk, btcHtlcAddress, btcHtlcRefund } from '../../core/btc.mjs';

const DATADIR = process.env.NV3_DATADIR ?? '/root/nv3-playground/chain';
const RPCPORT = Number(process.env.NV3_RPCPORT ?? 19660);
const LISTEN = Number(process.env.NV3_LISTEN ?? 5181);
const MINE_EVERY_MS = Number(process.env.NV3_MINE_MS ?? 20000);
// cross-chain swap: the relay is the BTC-side liquidity bot (regtest test coins, like the FRC
// faucet). It holds only its OWN BTC; the user is non-custodial (a refund timeout protects them).
const BTC_PORT = Number(process.env.BTC_RPCPORT ?? 19332);
const BTC_DATADIR = process.env.BTC_DATADIR ?? '/root/btc-regtest';
const BTC_WALLET = process.env.BTC_WALLET ?? 'swap';
const BTC_NET = process.env.BTC_NET ?? 'regtest';         // regtest | signet | testnet | main
const BTC_ONDEMAND = BTC_NET === 'regtest';               // only regtest can mine blocks on demand
const BTC_HRP = { regtest: 'bcrt', signet: 'tb', testnet: 'tb', main: 'bc' }[BTC_NET] ?? 'bcrt';
const SWAP_RATE = Number(process.env.SWAP_RATE ?? 0.2);   // BTC per 1 FRC (demo price)
// refund offsets in BLOCKS. FRC (T1) must outlast BTC (T2) so the user is never squeezed.
// Real BTC blocks are ~10 min: 20/10 blocks ≈ 3h/1.5h. FRC blocks are fast, so scale T1 up.
const SWAP_T2 = BTC_ONDEMAND ? 20 : 10;
const SWAP_T1 = BTC_ONDEMAND ? 40 : 4000;
// Reverse direction (maker SELLS BTC): the FRC leg is the NEAR one (taker refund) and the BTC leg
// is the FAR one (maker refund) — the mirror of the forward T1<->T2 ordering. Maker reveals R by
// claiming FRC, so its window closes first; the taker then has until the (later) BTC timeout.
const REV_TF = BTC_ONDEMAND ? 20 : 40;      // FRC HTLC cltv offset — the near leg (taker refund)
const REV_TB = BTC_ONDEMAND ? 40 : 12;      // BTC HTLC cltv offset — the far leg (maker refund)
const HOST_TAG = '00'.repeat(20);

const sha256 = b => createHash('sha256').update(b).digest();
const hash256 = b => sha256(sha256(b));
const ripemd160 = b => createHash('ripemd160').update(b).digest();
const hash160 = b => ripemd160(sha256(b));
const rev = hex => hex.match(/../g).reverse().join('');

let cookie = '';
const refreshCookie = () => { cookie = Buffer.from(readFileSync(`${DATADIR}/regtest/.cookie`)).toString('base64'); };
async function rpc(method, ...params) {
  const call = async () => {
    const res = await fetch(`http://127.0.0.1:${RPCPORT}/wallet/w`, {
      method: 'POST', headers: { Authorization: `Basic ${cookie}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 401) throw new Error('401');
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  };
  try { return await call(); } catch (e) {
    if (String(e.message) === '401') { refreshCookie(); return await call(); }
    throw e;
  }
}

// OP_TRUE leg for issuance funding (chain-admin convenience, holds no user value)
const TRUE_SCRIPT = '51', TRUE_REVEAL = '00' + TRUE_SCRIPT;
const TRUE_SPK = '0020' + hash256(Buffer.from(TRUE_REVEAL, 'hex')).toString('hex');
const TRUE_WITNESS = [TRUE_REVEAL, ''];

// ---- chain index (rebuilt from block 0 at startup, then follows the tip) ----
const utxos = new Map();     // 'txid:n' -> {spk, assetTag(null=host), value(bigint), refheight}
const assets = new Map();    // tag -> {name?, shift, interest, granularity, supply, issuedAt}
const spkIndex = new Map();  // spk -> Set(outpoint)
let indexedHeight = -1;
const events = [];           // rolling feed
const say = m => { events.unshift({ t: Date.now(), m }); if (events.length > 100) events.pop(); };

const addU = (op, u) => { utxos.set(op, u); (spkIndex.get(u.spk) ?? spkIndex.set(u.spk, new Set()).get(u.spk)).add(op); };
const delU = op => { const u = utxos.get(op); if (u) { utxos.delete(op); spkIndex.get(u.spk)?.delete(op); } };

async function indexBlock(h) {
  const hash = await rpc('getblockhash', h);
  const blk = await rpc('getblock', hash, 2);
  for (const tx of blk.tx) {
    for (const vin of tx.vin) if (vin.txid) delU(`${vin.txid}:${vin.vout}`);
    // asset definitions (OP_RETURN 'FRA1' + def) -> registry, plus a companion 'FRAN' name
    // OP_RETURN in the same tx (consensus ignores it; re-read here so names survive restarts).
    let definedTag = null, declaredName = null;
    for (const o of tx.vout) {
      const spk = o.scriptPubKey.hex;
      if (spk.startsWith('6a') && spk.includes('46524131')) {
        const defHex = spk.slice(spk.indexOf('46524131') + 8);
        const def = Buffer.from(defHex, 'hex');
        if (def.length >= 42) {
          const tag = hash160(def.subarray(0, def.length)).toString('hex');
          definedTag = tag;
          if (!assets.has(tag)) assets.set(tag, {
            shift: def[0], interest: (def[1] & 1) !== 0, granularity: 1,
            name: null, supply: 0n, issuedAt: tx.lockheight,
          });
        }
      } else if (spk.startsWith('6a') && spk.includes('4652414e')) {
        try { declaredName = Buffer.from(spk.slice(spk.indexOf('4652414e') + 8), 'hex').toString('utf8').replace(/[<>&"'\x00-\x1f\x7f]/g, '').slice(0, 32).trim(); } catch { /* not a name */ }
      }
    }
    if (definedTag && declaredName && assets.has(definedTag)) {
      // committed FRAN string may carry display decimals as a "name|D" suffix (self-certified
      // with the name itself — the def hashes the WHOLE string)
      const dm = declaredName.match(/^(.*)\|([0-8])$/);
      const a = assets.get(definedTag);
      if (dm) { a.name = dm[1]; a.decimals = +dm[2]; } else { a.name = declaredName; a.decimals = 0; }
    }
    tx.vout.forEach((o, n) => {
      if (o.scriptPubKey.hex.startsWith('6a')) return;   // OP_RETURN: unspendable
      const tag = o.assetTag ? rev(o.assetTag) : null;   // RPC shows uint160 hex reversed
      const u = { spk: o.scriptPubKey.hex, assetTag: tag, value: BigInt(Math.round(o.value * 1e8)), refheight: tx.lockheight };
      addU(`${tx.txid}:${n}`, u);
      if (tag && assets.has(tag) && h === (assets.get(tag).issuedAt ?? h)) assets.get(tag).supply += u.value;
    });
  }
  indexedHeight = h;
}
async function catchUp() {
  const tip = await rpc('getblockcount');
  while (indexedHeight < tip) await indexBlock(indexedHeight + 1);
}

// pre-signed ladder: [{lockHeight, witness}] ascending; the CURRENT rung is the highest one
// not above the chain tip — buyers' coins only need to be older than that rung.
const sanitizeLadder = l => Array.isArray(l) && l.length
  ? l.filter(r => r && Number.isFinite(Number(r.lockHeight)) && Array.isArray(r.witness) && r.witness.length >= 2)
     .map(r => ({ lockHeight: Number(r.lockHeight), witness: r.witness }))
     .sort((a, b) => a.lockHeight - b.lockHeight).slice(0, 5000)
  : null;
const rungAt = (o, h) => {
  let best = null;
  for (const r of (o.ladder || [])) { if (r.lockHeight <= h && (!best || r.lockHeight > best.lockHeight)) best = r; }
  return best || { lockHeight: o.lockHeight, witness: o.witness };
};

// ---- AUTO-MATCHER: splice two crossing ranged offers into ONE tx. Permissionless by design
// (any client could do this); the relay just runs the default bot. It cannot steal: both
// signatures pin destinations and price floors — the matcher only takes the spread, funding
// the fee from the OP_TRUE pool. Requires a COMMON rung height (grid-aligned ladders).
const FEE = 10000n;
const opPrev = op => ({ txid: rev(op.split(':')[0]), vout: +op.split(':')[1] });
function repointAfterFill(o, changeOp, h) {
  const c = utxos.get(changeOp);
  const cpv = c ? pvOf(c, h) : 0n;
  if (c && c.spk === o.desc.changeScript && cpv > 0n && cpv >= BigInt(o.desc.minFill)) {
    o.giveOutpoint = changeOp; o.witness = null; o.ladder = []; o.needsResign = true; o.status = 'open';
  } else o.status = 'filled';
  saveBook();
}
async function ensureMatcherFuel() {
  for (const op of spkIndex.get(TRUE_SPK) ?? []) { const u = utxos.get(op); if (u && !u.assetTag && u.value >= FEE + 10000n) return; }
  try {
    const dec = await rpc('decodescript', TRUE_SPK);
    await rpc('sendtoaddress', dec.address, '0.01');
    await rpc('generatetoaddress', 1, mineAddr); await catchUp();
  } catch (e) { say('матчер: нет топлива: ' + String(e.message).slice(0, 60)); }
}
async function matchCrosses() {
  const h = indexedHeight;
  const open = book.filter(o => o.ranged && o.status === 'open' && !o.needsResign && (o.ladder || []).length && utxos.has(o.giveOutpoint));
  for (const A of open) for (const B of open) {
    if (A.id === B.id) continue;
    const aGive = utxos.get(A.giveOutpoint), bGive = utxos.get(B.giveOutpoint);
    if (!aGive || !bGive) continue;
    const T = aGive.assetTag;
    if (T === null || bGive.assetTag !== null) continue;          // A sells asset T, B sells FRC
    if ((A.desc.payoutAsset ?? HOST_TAG) !== HOST_TAG) continue;  // A wants FRC
    if ((B.desc.payoutAsset ?? HOST_TAG) !== T) continue;         // B wants T
    const nA = BigInt(A.desc.priceNum), dA = BigInt(A.desc.priceDen);
    const nB = BigInt(B.desc.priceNum), dB = BigInt(B.desc.priceDen);
    if (nA * nB > dA * dB) continue;                              // prices do not cross
    if ((A.nExpireTime && h > A.nExpireTime) || (B.nExpireTime && h > B.nExpireTime)) continue;
    // highest COMMON rung not above the tip (both signatures must commit the same lock_height)
    const bH = new Set((B.ladder || []).map(r => r.lockHeight));
    let L = -1;
    for (const r of (A.ladder || [])) if (r.lockHeight <= h && bH.has(r.lockHeight) && r.lockHeight > L) L = r.lockHeight;
    if (L < 0) continue;
    const wA = A.ladder.find(r => r.lockHeight === L)?.witness, wB = B.ladder.find(r => r.lockHeight === L)?.witness;
    if (!wA || !wB) continue;
    if (aGive.refheight > L || bGive.refheight > L) continue;     // coins must predate the rung
    const pvA = pvOf(aGive, L), pvB = pvOf(bGive, L);
    const minA = BigInt(A.desc.minFill), maxA = BigInt(A.desc.maxFill);
    const minB = BigInt(B.desc.minFill), maxB = BigInt(B.desc.maxFill);
    // fills: start from B's full FRC capacity, shrink to A's asset capacity
    let f = pvB < maxB ? pvB : maxB;
    let t = (f * nB + dB - 1n) / dB;
    const tCap = pvA < maxA ? pvA : maxA;
    if (t > tCap) { t = tCap; f = t * dB / nB; if (f > pvB) f = pvB; }
    const payB = (f * nB + dB - 1n) / dB;                          // T owed to B (price floor)
    const payA = (t * nA + dA - 1n) / dA;                          // FRC owed to A (price floor)
    if (payB > t || payA > f) continue;                            // rounding killed the cross
    if (t < minA || t > maxA || f < minB || f > maxB || t <= 0n || f <= 0n) continue;
    // matcher fuel: an OP_TRUE host coin old enough for the rung
    let fuelOp = null, fuel = null;
    for (const op of spkIndex.get(TRUE_SPK) ?? []) {
      const u = utxos.get(op);
      if (u && !u.assetTag && u.refheight <= L && u.value >= FEE + 1000n) { fuelOp = op; fuel = u; break; }
    }
    if (!fuelOp) continue;
    const fuelPv = pvOf(fuel, L);
    const spreadT = t - payB, spreadF = f - payA;
    const vout = [
      { value: payA, scriptPubKey: A.desc.payoutScript, assetTag: HOST_TAG },     // ranged[0] payout
      { value: pvA - t, scriptPubKey: A.desc.changeScript, assetTag: T },          // ranged[0] change
      { value: payB, scriptPubKey: B.desc.payoutScript, assetTag: T },             // ranged[1] payout
      { value: pvB - f, scriptPubKey: B.desc.changeScript, assetTag: HOST_TAG },   // ranged[1] change
    ];
    if (spreadT > 0n) vout.push({ value: spreadT, scriptPubKey: TRUE_SPK, assetTag: T });
    const frcBack = fuelPv - FEE + spreadF;
    if (frcBack > 0n) vout.push({ value: frcBack, scriptPubKey: TRUE_SPK, assetTag: HOST_TAG });
    const tx = {
      version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: L, nExpireTime: 0,
      vin: [
        { prevout: opPrev(A.giveOutpoint), scriptSig: '', sequence: 0xffffffff, witness: wA },
        { prevout: opPrev(B.giveOutpoint), scriptSig: '', sequence: 0xffffffff, witness: wB },
        { prevout: opPrev(fuelOp), scriptSig: '', sequence: 0xffffffff, witness: TRUE_WITNESS },
      ],
      ranged: [
        { nIn: 1, payoutAsset: HOST_TAG, payoutScript: A.desc.payoutScript, priceNum: nA, priceDen: dA, changeScript: A.desc.changeScript, minFill: minA, maxFill: maxA, nExpireTime: A.nExpireTime ?? 0 },
        { nIn: 1, payoutAsset: T, payoutScript: B.desc.payoutScript, priceNum: nB, priceDen: dB, changeScript: B.desc.changeScript, minFill: minB, maxFill: maxB, nExpireTime: B.nExpireTime ?? 0 },
      ],
      vout,
    };
    try {
      const raw = serializeTx(tx);
      await rpc('generateblock', mineAddr, [raw]);
      await catchUp();
      const txid = computeTxid(parseTx(raw));
      repointAfterFill(A, `${txid}:1`, indexedHeight);
      repointAfterFill(B, `${txid}:3`, indexedHeight);
      reconcileBook();
      say(`автомэтч #${A.id} × #${B.id}: ${t} за ${f} kria (${txid.slice(0, 12)}…), спред ${spreadT}+${spreadF}`);
      return;                                                       // one match per tick
    } catch (e) { say('матчер: ' + String(e.message).slice(0, 80)); }
  }
}

// Swap watcher: for a BTC-funded swap, detect the user's claim on the BTC chain, read the
// revealed preimage from its witness, and claim the escrowed FRC. Also refund expired swaps.
function reconcileP2p() {
  // Prune the board of anything settled or dead so it only ever shows live offers:
  //   - terminal states (done/cancelled/expired) go immediately;
  //   - a completed swap: btc_claimed whose FRC HTLC coin was spent (taker claimed) is done;
  //   - a 'taken' offer the maker never funded within a grace window is a zombie.
  const GRACE = 30;
  let changed = false;
  for (let i = p2p.length - 1; i >= 0; i--) {
    const w = p2p[i];
    const settled = ['done', 'cancelled', 'expired'].includes(w.status);
    const takerClaimed = w.status === 'btc_claimed' && w.frcHtlc && !utxos.has(`${w.frcHtlc.txid}:${w.frcHtlc.vout}`);
    const zombie = w.status === 'taken' && !w.frcHtlc && w.takenAt != null && indexedHeight - w.takenAt > GRACE;
    if (settled || takerClaimed || zombie) { p2p.splice(i, 1); changed = true; }
  }
  if (changed) saveP2p();
}
async function watchP2p() {
  reconcileP2p();
  if (!btcAvail()) return;
  for (const w of p2p) {
    try {
      // auto-detect the taker's BTC funding to the HTLC address (mempool + confirmed) — no txid
      if (w.status === 'frc_funded' && w.btcHtlc && !w.btcHtlc.txid) {
        const utxo = await btcWatch('listunspent', 0, 9999999, [w.btcHtlc.addr]).catch(() => []);
        const hit = (utxo || []).find(u => BigInt(Math.round(u.amount * 1e8)) >= BigInt(w.btcAmount));
        if (hit) {
          w.btcHtlc.txid = hit.txid; w.btcHtlc.vout = hit.vout; w.btcHtlc.value = String(Math.round(hit.amount * 1e8));
          w.status = 'btc_funded'; saveP2p();
          say(`P2P ${w.id}: BTC-платёж определён автоматически (${hit.txid.slice(0, 12)}…)`);
        }
      }
      if (w.status === 'btc_funded' && w.btcClaimTxid && !w.preimage) {
        const R = await preimageFromTx(w.btcClaimTxid, w.paymentHash);
        if (R) { w.preimage = R; w.status = 'btc_claimed'; saveP2p(); }
      }
    } catch {}
  }
}
async function watchSwaps() {
  if (!btcAvail()) return;
  const h = await rpc('getblockcount').catch(() => 0);
  for (const w of swaps) {
    try {
      if (w.status === 'btc_funded') {
        if (!w.btcClaimTxid) continue;                         // user hasn't broadcast their BTC claim yet
        const R = await preimageFromTx(w.btcClaimTxid, w.paymentHash);   // mempool or confirmed
        if (!R) continue;
        w.preimage = R;
        // claim the FRC HTLC with R (relay is the claim party)
        const f = w.frcHtlc;
        const bobSpk = '0014' + hash160(Buffer.from(pubkeyCompressed(relayKey(w.id, 'frc')), 'hex')).toString('hex');
        const c = claimReceived({ funding: { txid: f.txid, vout: f.vout, value: BigInt(f.value), refheight: f.refheight },
          leaf: f.leaf, preimage: R, ourKey: relayKey(w.id, 'frc'), toSpk: bobSpk, fee: 2000n });
        await rpc('generateblock', mineAddr, [c.rawtx]); await catchUp();
        w.status = 'done'; saveSwaps();
        say(`своп ${w.id}: завершён — FRC получены релеем, BTC у пользователя ✅`);
      } else if ((w.status === 'created' || w.status === 'btc_funded') && w.t1 && h > w.t1 + 2) {
        w.status = 'expired'; saveSwaps();
      }
    } catch (e) { say(`своп ${w.id}: ` + String(e.message).slice(0, 60)); }
  }
}
async function preimageFromTx(txid, paymentHash) {
  // works whether the claim is unconfirmed (mempool) or mined — getrawtransaction reads both
  const tx = await btcRpc('getrawtransaction', txid, true).catch(() => null);
  if (!tx) return null;
  for (const vin of tx.vin) for (const item of (vin.txinwitness || []))
    if (/^[0-9a-f]{64}$/.test(item) && sha256(Buffer.from(item, 'hex')).toString('hex') === paymentHash) return item;
  return null;
}
// Reverse direction: R is revealed on the FRC chain (the maker's FRC claim). Pull it straight from
// the raw claim tx's input witnesses — the 32-byte item that hashes to paymentHash is R.
function frcPreimageFromRaw(rawtx, paymentHash) {
  try { const tx = parseTx(rawtx);
    for (const vin of tx.vin) for (const item of (vin.witness || []))
      if (/^[0-9a-f]{64}$/.test(item) && sha256(Buffer.from(item, 'hex')).toString('hex') === paymentHash) return item;
  } catch {}
  return null;
}

const rateOf = tag => tag === null ? { k: 20, interest: false }
  : { k: assets.get(tag)?.shift ?? 20, interest: !!assets.get(tag)?.interest };
const pvOf = (u, h) => assetPresentValue(u.value, h - u.refheight, rateOf(u.assetTag));

// ---- order book: a PURE RELAY of user-signed SINGLE|ACP offers ----
// The server never matches. It stores offers (with the maker's partial signature — public by
// design; that signature only completes against a crossing counter-offer) and lists them.
// ANY client splices two crossing offers with its OWN fee coin, keeps the spread, and
// broadcasts the composite via /api/tx — permissionless matching, no privileged house.
// phase-1: {id, giveOutpoint, makerSpk, want, lockHeight, sequence, witness, status}
// phase-2b ranged: {id, ranged:true, makerSpk, giveOutpoint, desc, nExpireTime, lockHeight,
//   witness, needsResign, status} — a signed CONSTRAINT (price ratio + fill bounds) whose give
//   coin partially fills. Each fill spends the give coin and returns a smaller change coin, which
//   the maker's client re-signs (resignRanged) to keep the remainder tradeable.
// ---- Bitcoin side (relay = the BTC liquidity counterparty) ----
let btcCookie = '';
const BTC_COOKIE = `${BTC_DATADIR}/${BTC_NET === 'main' ? '' : BTC_NET + '/'}.cookie`;
const btcAvail = () => existsSync(BTC_COOKIE);
async function btcRpcOn(path, method, ...params) {
  btcCookie = Buffer.from(readFileSync(BTC_COOKIE)).toString('base64');
  const res = await fetch(`http://127.0.0.1:${BTC_PORT}${path}`, {
    method: 'POST', headers: { Authorization: `Basic ${btcCookie}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`btc ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}
const btcRpc = (m, ...p) => btcRpcOn(`/wallet/${BTC_WALLET}`, m, ...p);
// a watch-only wallet the relay uses to auto-detect HTLC funding (no keys, no rescan)
const WATCH = 'p2pwatch';
const btcWatch = (m, ...p) => btcRpcOn(`/wallet/${WATCH}`, m, ...p);
async function ensureWatchWallet() {
  try { await btcRpcOn('', 'loadwallet', WATCH); } catch {}
  // wallet_name, disable_private_keys=true, blank=true, passphrase, avoid_reuse, descriptors=true
  try { await btcRpcOn('', 'createwallet', WATCH, true, true, '', false, true); } catch {}
}
// One-shot background deep rescan: `watchAddress` imports with timestamp "now" (fast, sees only
// FUTURE receives), so funds an address already holds stay invisible. When a NOT-yet-deep-scanned
// address appears, kick off a single bounded rescanblockchain over the recent window — fire and
// forget so the request returns instantly; the funds show on a later poll. Rescans the whole
// watch wallet, so we debounce to one in-flight rescan and only trigger on genuinely new addresses.
const btcDeep = new Set();
let btcRescanning = false;
function btcDeepScan(addrs) {
  const fresh = addrs.filter(a => !btcDeep.has(a));
  if (!fresh.length || btcRescanning) return;
  fresh.forEach(a => btcDeep.add(a));
  btcRescanning = true;
  (async () => {
    try {
      const tip = await btcRpc('getblockcount');
      const start = Math.max(0, tip - 30000);   // ~months of signet — far older than anything this wallet touched
      say(`btc: rescan watch wallet from ${start} for ${fresh.length} new addr(s)`);
      await btcWatch('rescanblockchain', start);
    } catch (e) { /* rescan busy or node hiccup — a later poll retries via a new address */ }
    finally { btcRescanning = false; }
  })();
}
async function watchAddress(addr) {
  const info = await btcRpc('getdescriptorinfo', `addr(${addr})`).catch(() => null);
  const desc = info ? `addr(${addr})#${info.checksum}` : `addr(${addr})`;
  try { await btcWatch('importdescriptors', [{ desc, timestamp: 'now', label: 'p2p' }]); } catch {}
}
const btcMine = async n => { if (BTC_ONDEMAND) return btcRpc('generatetoaddress', n, await btcRpc('getnewaddress')); };

// the relay's per-swap keys (deterministic from a persisted seed; they touch only the relay's
// own BTC float and the escrowed FRC it is owed — never a user's coins).
const RELAY_SEED_FILE = `${DATADIR}/relay-swap-seed`;
if (!existsSync(RELAY_SEED_FILE)) writeFileSync(RELAY_SEED_FILE, randomBytes(32).toString('hex'));
const RELAY_SEED = readFileSync(RELAY_SEED_FILE, 'utf8').trim();
const relayKey = (id, leg) => sha256(Buffer.from(RELAY_SEED + id + leg, 'utf8')).toString('hex');

// ---- swap board: persisted like the offer book ----
const swaps = [];
let swapSeq = 1;
const p2p = [];
let p2pSeq = 1;
const P2P_FILE = `${DATADIR}/market-p2p.json`;
let p2pSaveTimer = null;
function saveP2p() {
  if (p2pSaveTimer) return;
  p2pSaveTimer = setTimeout(() => { p2pSaveTimer = null;
    try { writeFileSync(P2P_FILE, JSON.stringify({ p2pSeq, p2p })); } catch {} }, 250);
}
function loadP2p() {
  try { const j = JSON.parse(readFileSync(P2P_FILE, 'utf8')); if (Array.isArray(j.p2p)) { p2p.push(...j.p2p); p2pSeq = Number(j.p2pSeq) || p2p.length + 1; } } catch {}
}
const SWAP_FILE = `${DATADIR}/market-swaps.json`;
let swapSaveTimer = null;
function saveSwaps() {
  if (swapSaveTimer) return;
  swapSaveTimer = setTimeout(() => { swapSaveTimer = null;
    try { writeFileSync(SWAP_FILE, JSON.stringify({ swapSeq, swaps })); } catch {} }, 250);
}
function loadSwaps() {
  try { const j = JSON.parse(readFileSync(SWAP_FILE, 'utf8')); if (Array.isArray(j.swaps)) { swaps.push(...j.swaps); swapSeq = Number(j.swapSeq) || swaps.length + 1; } } catch {}
}

const book = [];
let offerSeq = 1;

// ---- book persistence: the catalogue survives relay restarts. Everything in an offer is
// already JSON-safe (amounts ride as strings); coins/validity re-derive from the chain index,
// and reconcileBook() at boot retires whatever was spent/expired while we were down.
const BOOK_FILE = `${DATADIR}/market-book.json`;
let saveTimer = null;
function saveBook() {                        // debounced — mutations arrive in bursts
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeFileSync(BOOK_FILE, JSON.stringify({ offerSeq, book })); } catch (e) { say('книга не сохранилась: ' + String(e.message).slice(0, 60)); }
  }, 250);
}
function loadBook() {
  try {
    const j = JSON.parse(readFileSync(BOOK_FILE, 'utf8'));
    if (Array.isArray(j.book)) { book.push(...j.book); offerSeq = Number(j.offerSeq) || book.length + 1; }
    say(`каталог восстановлен: ${book.length} предложений`);
  } catch { /* first run — no file yet */ }
}

// Mark an offer done once its give coin leaves the UTXO set. A ranged fill re-points the offer
// at its change coin FIRST (in the tx handler, before this runs), so a ranged offer only trips
// this if its coin was spent by something else (another offer, a manual spend) — it is then
// orphaned and unfillable, so retire it instead of leaving a dead "open" row.
function reconcileBook() {
  const before = book.map(o => o.status + o.giveOutpoint).join();
  for (const o of book) if (o.status === 'open' && o.nExpireTime && indexedHeight > o.nExpireTime) o.status = 'expired';
  for (const o of book) if (o.status === 'open' && !utxos.has(o.giveOutpoint)) o.status = 'filled';
  // a give coin that exists but is worth nothing (fully-taken change, or melted away) is done too
  for (const o of book) if (o.status === 'open') { const c = utxos.get(o.giveOutpoint); if (c && BigInt(c.value) === 0n) o.status = 'filled'; }
  if (book.map(o => o.status + o.giveOutpoint).join() !== before) saveBook();
}

// ---- lifecycle ----
let mineAddr = null;
async function bootstrap() {
  refreshCookie();
  try { await rpc('createwallet', 'w'); } catch {}
  try { await rpc('loadwallet', 'w'); } catch {}
  mineAddr = await rpc('getnewaddress');
  if (await rpc('getblockcount') < 120) await rpc('generatetoaddress', 120, mineAddr);
  loadBook(); loadSwaps(); loadP2p();
  if (btcAvail()) { await ensureWatchWallet();
    for (const w of p2p) if (w.status === 'frc_funded' && w.btcHtlc && !w.btcHtlc.txid) await watchAddress(w.btcHtlc.addr).catch(() => {}); }
  await catchUp();
  reconcileBook();   // retire offers whose coins were spent / expired while the relay was down
  say('маркет запущен (релей книги + майнер + автомэтчер)');
  // the miner role only: produce a block on a timer so the chain lives. No matching here.
  setInterval(async () => {
    try {
      await rpc('generatetoaddress', 1, mineAddr);
      await catchUp();
      reconcileBook();
      await ensureMatcherFuel();
      await matchCrosses();
      await watchSwaps();
      await watchP2p();
    } catch (e) { say('майнер: ' + String(e.message).slice(0, 80)); }
  }, MINE_EVERY_MS);
}

// ---- API ----
const api = {
  async info() {
    const h = await rpc('getblockcount');
    return {
      height: h, mineEveryMs: MINE_EVERY_MS,
      assets: [...assets.entries()].map(([tag, a]) => ({ tag, ...a, supply: String(a.supply) })),
      // the book exposes EVERYTHING a client needs to splice a cross itself: the give
      // outpoint, the maker's partial witness, terms. The witness is a SINGLE|ACP signature —
      // public by design, it binds only "my coin ↔ this exact output" and does nothing until
      // a crossing counter-offer completes the balance.
      book: book.slice(-80).map(o => {
        const g = utxos.get(o.giveOutpoint);
        const give = g ? { assetTag: g.assetTag, value: String(g.value), refheight: g.refheight, pv: String(pvOf(g, h)) } : null;
        const rung = o.ranged ? rungAt(o, h) : { lockHeight: o.lockHeight, witness: o.witness };
        const base = { id: o.id, status: o.status, makerSpk: o.makerSpk, lockHeight: rung.lockHeight, giveOutpoint: o.giveOutpoint, witness: rung.witness, give };
        return o.ranged
          ? { ...base, ranged: true, desc: o.desc, nExpireTime: o.nExpireTime, needsResign: !!o.needsResign }
          : { ...base, sequence: o.sequence, want: { assetTag: o.want.assetTag, value: String(o.want.value) } };
      }),
      events: events.slice(0, 30),
    };
  },
  async utxos({ spks }) {
    const h = await rpc('getblockcount');
    const out = [];
    for (const spk of spks ?? []) for (const op of spkIndex.get(spk) ?? []) {
      const u = utxos.get(op);
      out.push({ outpoint: op, spk, assetTag: u.assetTag, value: String(u.value), refheight: u.refheight, pv: String(pvOf(u, h)) });
    }
    return { height: h, utxos: out };
  },
  async faucet({ address }) {
    const txid = await rpc('sendtoaddress', address, '1.0');
    await rpc('generatetoaddress', 1, mineAddr);
    await catchUp();
    say(`кран: 1 FRC → ${address.slice(0, 16)}…`);
    return { txid };
  },
  async issue({ name, shift, interest, amount, spk, decimals }) {
    shift = Math.min(64, Math.max(1, Number(shift) || 16));
    const d = Math.min(8, Math.max(0, Number(decimals) || 0));
    // display decimals: one shown unit = 10^d base units — issue that many more base units so
    // demurrage melts fractions instead of eating whole tokens (base units stay granularity-1)
    const amt = BigInt(amount) * 10n ** BigInt(d);
    if (amt <= 0n || amt > 9007199254740991n) throw new Error('bad amount');
    if (!/^[0-9a-f]{4,140}$/.test(spk)) throw new Error('bad spk');
    // the human name, sanitized once and used everywhere: its sha256 goes in the def (so the tag
    // commits it) AND the raw string goes in a companion 'FRAN' OP_RETURN (so indexers recover it).
    // Decimals ride INSIDE the committed string as a "name|D" suffix — self-certified with it.
    const nm0 = String(name ?? 'asset').replace(/[<>&"'|\x00-\x1f\x7f]/g, '').slice(0, 30).trim() || 'asset';
    const nm = d ? `${nm0}|${d}` : nm0;
    const def = Buffer.concat([Buffer.from([shift, interest ? 1 : 0]), Buffer.alloc(8), sha256(Buffer.from(nm, 'utf8'))]);
    def.writeUInt8(1, 2);
    const tag = hash160(def).toString('hex');
    if (assets.has(tag)) throw new Error('актив с таким именем и параметрами уже существует');
    const dec = await rpc('decodescript', TRUE_SPK);
    const ftx = await rpc('sendtoaddress', dec.address, '0.01');
    const raw = await rpc('getrawtransaction', ftx, true);
    const v = raw.vout.findIndex(o => o.scriptPubKey.hex === TRUE_SPK);
    await rpc('generatetoaddress', 1, mineAddr);
    const fval = BigInt(Math.round(raw.vout[v].value * 1e8));
    const tx = {
      version: NV3_TX_VERSION, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: raw.lockheight, nExpireTime: 0,
      vin: [{ prevout: { txid: rev(ftx), vout: v }, scriptSig: '', sequence: 0xffffffff, witness: TRUE_WITNESS }],
      vout: [
        { value: amt, scriptPubKey: spk, assetTag: tag },
        { value: 0n, scriptPubKey: '6a' + (4 + def.length).toString(16).padStart(2, '0') + '46524131' + def.toString('hex') },
        { value: fval - 100000n, scriptPubKey: TRUE_SPK },
      ],
    };
    // companion 'FRAN' name OP_RETURN (consensus ignores it; indexers read it from-chain). Its
    // sha256 is committed in the def above, so a reader can verify the name against the tag.
    const nmeta = Buffer.from(nm, 'utf8');
    tx.vout.push({ value: 0n, scriptPubKey: '6a' + (4 + nmeta.length).toString(16).padStart(2, '0') + '4652414e' + nmeta.toString('hex') });
    await rpc('generateblock', mineAddr, [serializeTx(tx)]);
    await catchUp();
    Object.assign(assets.get(tag), { name: nm0, decimals: d });
    say(`выпуск: «${nm0}» ×${amount}${d ? ` (.${d})` : ''} (shift ${shift}${interest ? ', растёт' : ''})`);
    return { tag, txid: computeTxid(tx) };
  },
  async tx({ rawtx, kind, offerId }) {
    const parsed = parseTx(rawtx);            // sanity: it parses
    await rpc('generateblock', mineAddr, [rawtx]);
    await catchUp();
    const txid = computeTxid(parsed);
    // a ranged partial fill: re-point the offer at its change coin (the ranged bundle's 2nd
    // output) FIRST, so reconcileBook below sees the live change coin and doesn't retire it. The
    // change coin needs a fresh maker signature to stay tradeable; exhausted (< minFill) ⇒ done.
    if (kind === 'rangedfill' && offerId != null) {
      const o = book.find(x => x.id === Number(offerId) && x.ranged);
      if (o) {
        const h = await rpc('getblockcount');
        const changeOp = `${txid}:1`;
        const c = utxos.get(changeOp);
        const cpv = c ? pvOf(c, h) : 0n;
        // a zero-value change means the offer was taken WHOLE — it is done, not resignable
        if (c && c.spk === o.desc.changeScript && cpv > 0n && cpv >= BigInt(o.desc.minFill)) {
          o.giveOutpoint = changeOp; o.witness = null; o.ladder = []; o.needsResign = true; o.status = 'open';
        } else { o.status = 'filled'; }
        saveBook();
      }
    }
    reconcileBook();                          // retire any offer whose give coin this tx consumed
    say(kind === 'match' ? `сделка сведена участником (${txid.slice(0, 12)}…)`
      : kind === 'rangedfill' ? `частичный филл ranged-оффера #${offerId} (${txid.slice(0, 12)}…)`
      : `транзакция пользователя замайнена (${txid.slice(0, 12)}…)`);
    return { txid };
  },
  async offer({ giveOutpoint, makerSpk, want, lockHeight, sequence, witness }) {
    const g = utxos.get(giveOutpoint);
    if (!g) throw new Error('монета не найдена/уже потрачена');
    if (g.spk !== makerSpk) throw new Error('монета не принадлежит этому ключу');
    if (!Array.isArray(witness) || witness.length < 2) throw new Error('нет подписи');
    const o = { id: offerSeq++, giveOutpoint, makerSpk, lockHeight: Number(lockHeight),
      sequence: Number(sequence ?? 0xffffffff),
      want: { assetTag: want.assetTag ?? null, value: BigInt(want.value) }, witness, status: 'open' };
    book.push(o);
    say(`новый оффер #${o.id} (ждёт, пока любой участник сведёт)`);
    return { id: o.id };
  },
  // phase-2b: a ranged (partial-fill) offer. The maker signs a descriptor (price ratio + fill
  // bounds) over ONE give coin; the server only relays it, exactly like phase-1 offers.
  async rangedOffer({ makerSpk, giveOutpoint, desc, nExpireTime, lockHeight, witness }) {
    const g = utxos.get(giveOutpoint);
    if (!g) throw new Error('монета не найдена/уже потрачена');
    if (g.spk !== makerSpk) throw new Error('монета не принадлежит этому ключу');
    if (!desc || desc.payoutScript == null || desc.changeScript == null) throw new Error('плохой дескриптор');
    if (!Array.isArray(witness) || witness.length < 2) throw new Error('нет подписи');
    const o = { id: offerSeq++, ranged: true, makerSpk, giveOutpoint,
      desc: { payoutAsset: desc.payoutAsset ?? '00'.repeat(20), payoutScript: desc.payoutScript,
        priceNum: String(desc.priceNum), priceDen: String(desc.priceDen), changeScript: desc.changeScript,
        minFill: String(desc.minFill), maxFill: String(desc.maxFill),
        ...(desc.nExpireTime != null ? { nExpireTime: Number(desc.nExpireTime) } : {}) },
      nExpireTime: Number(nExpireTime ?? 0), lockHeight: Number(lockHeight), witness,
      ladder: sanitizeLadder(arguments[0].ladder) ?? [{ lockHeight: Number(lockHeight), witness }],
      needsResign: false, status: 'open' };
    book.push(o);
    saveBook();
    say(`новый ranged-оффер #${o.id} (частичные филлы)`);
    return { id: o.id };
  },
  // the maker's client re-signs its change coin after a partial fill (only it holds the key).
  async resignRanged({ id, giveOutpoint, lockHeight, witness }) {
    const o = book.find(x => x.id === Number(id) && x.ranged);
    if (!o) throw new Error('нет такого ranged-оффера');
    if (giveOutpoint && giveOutpoint !== o.giveOutpoint) throw new Error('оффер указывает на другую монету');
    const g = utxos.get(o.giveOutpoint);
    if (!g || g.spk !== o.makerSpk) throw new Error('монета остатка недоступна');
    if (!Array.isArray(witness) || witness.length < 2) throw new Error('нет подписи');
    const fresh = sanitizeLadder(arguments[0].ladder);
    if (fresh) o.ladder = fresh;                                   // full re-ladder (new coin after a fill)
    else {                                                          // single tip rung: top the ladder up
      o.ladder = (o.ladder || []).filter(r => r.lockHeight !== Number(lockHeight));
      o.ladder.push({ lockHeight: Number(lockHeight), witness });
      o.ladder.sort((a, b) => a.lockHeight - b.lockHeight);
      if (o.ladder.length > 5000) o.ladder = o.ladder.slice(-5000);
    }
    o.witness = witness; o.lockHeight = Number(lockHeight); o.needsResign = false; o.status = 'open';
    saveBook();
    return { id: o.id };
  },
  async cancel({ id, makerSpk }) {
    const o = book.find(x => x.id === Number(id) && x.status === 'open');
    if (!o || o.makerSpk !== makerSpk) throw new Error('нет такого открытого оффера');
    o.status = 'cancelled';   // NB: true cancel = spend the coin; this only delists locally
    saveBook();
    return {};
  },
  // ---- in-wallet BTC account (non-custodial): the relay is a watch-only indexer + broadcaster.
  // It holds NO keys and NO funds — the wallet derives its BTC addresses and signs sends locally.
  // Here we only import those addresses watch-only, report their UTXOs, and rebroadcast signed txs.
  async btcAccount({ addresses }) {
    if (!btcAvail()) throw new Error('нет BTC-узла');
    if (!Array.isArray(addresses) || !addresses.length) return { balance: '0', utxos: [], hrp: BTC_HRP, net: BTC_NET };
    const addrs = addresses.filter(a => /^(bc|tb|bcrt)1[0-9a-z]{6,90}$/i.test(a)).slice(0, 200);
    await ensureWatchWallet();
    for (const a of addrs) await watchAddress(a).catch(() => {});
    btcDeepScan(addrs);   // one-shot background rescan so pre-existing funds (e.g. old swap proceeds) surface
    const list = await btcWatch('listunspent', 0, 9999999, addrs).catch(() => []);
    let bal = 0n;
    const utxos = list.map(u => { const sats = BigInt(Math.round(u.amount * 1e8)); bal += sats;
      return { txid: u.txid, vout: u.vout, address: u.address, spk: u.scriptPubKey, value: String(sats), confirmations: u.confirmations }; });
    return { balance: String(bal), utxos, hrp: BTC_HRP, net: BTC_NET };
  },
  async btcBroadcast({ rawtx }) {
    if (!btcAvail()) throw new Error('нет BTC-узла');
    if (!/^[0-9a-f]+$/i.test(rawtx || '')) throw new Error('плохая транзакция');
    const txid = await btcRpc('sendrawtransaction', rawtx);
    return { txid };
  },
  // ---- cross-chain swap (FRC -> BTC), relay = BTC liquidity bot ----
  async swapInfo() {
    return { available: btcAvail(), rate: SWAP_RATE, t1: SWAP_T1, t2: SWAP_T2, btcNet: BTC_NET, btcHrp: BTC_HRP,
      swaps: swaps.slice(-40).map(w => ({ id: w.id, status: w.status, frcAmount: w.frcAmount, btcAmount: w.btcAmount,
        maker: w.maker, relayFrcPub: w.relayFrcPub, relayBtcPub: w.relayBtcPub, paymentHash: w.paymentHash,
        t1: w.t1, t2: w.t2, frcHtlc: w.frcHtlc, btcHtlc: w.btcHtlc, preimage: w.preimage ?? null })) };
  },
  // 1. the user opens a swap: they hold the secret R, commit paymentHash=SHA256(R). The relay
  //    reserves its per-swap pubkeys (the user builds their FRC HTLC with relayFrcPub as claim).
  async swapCreate({ paymentHash, frcAmount, makerFrcPub, makerBtcPub }) {
    if (!btcAvail()) throw new Error('своп недоступен: нет BTC-узла');
    if (!/^[0-9a-f]{64}$/.test(paymentHash || '')) throw new Error('плохой paymentHash');
    if (!/^[0-9a-f]{66}$/.test(makerFrcPub || '') || !/^[0-9a-f]{66}$/.test(makerBtcPub || '')) throw new Error('плохие ключи');
    const frc = BigInt(frcAmount);
    if (frc <= 0n || frc > 100n * 100000000n) throw new Error('плохая сумма FRC');
    const btcAmount = BigInt(Math.round(Number(frc) * SWAP_RATE));   // sats
    const id = 'sw' + (swapSeq++);
    const w = { id, status: 'created', paymentHash, frcAmount: String(frc), btcAmount: String(btcAmount),
      maker: { frcPub: makerFrcPub, btcPub: makerBtcPub },
      relayFrcPub: pubkeyCompressed(relayKey(id, 'frc')), relayBtcPub: pubkeyCompressed(relayKey(id, 'btc')),
      t1: 0, t2: 0, frcHtlc: null, btcHtlc: null, preimage: null };
    swaps.push(w); saveSwaps();
    say(`своп ${id}: открыт (${Number(frc)/1e8} FRC -> ${Number(btcAmount)/1e8} BTC)`);
    return { id, relayFrcPub: w.relayFrcPub, relayBtcPub: w.relayBtcPub, btcAmount: String(btcAmount) };
  },
  // 2. the user funded the FRC HTLC (claim=relayFrcPub, refund=makerFrcPub, cltv=T1). They report
  //    the funding; the relay VERIFIES it on-chain, then funds the BTC HTLC (claim=makerBtcPub,
  //    refund=relayBtcPub, cltv=T2 < T1) from its own float.
  async swapFrcFunded({ id, txid, vout, leaf, t1 }) {
    const w = swaps.find(x => x.id === id); if (!w) throw new Error('нет такого свопа');
    if (w.status !== 'created') throw new Error('своп уже в работе');
    await catchUp();
    // verify the funding output pays the exact FRC HTLC these terms produce
    const want = frcLeg({ role: 'receive', ourKey: relayKey(id, 'frc'), theirPub: w.maker.frcPub, paymentHash: w.paymentHash, cltv: Number(t1), net: 'regtest' });
    if (want.leaf !== leaf) throw new Error('дескриптор FRC HTLC не совпадает');
    const u = utxos.get(`${txid}:${vout}`);
    if (!u || u.assetTag !== null || u.spk !== want.spk) throw new Error('FRC HTLC не найден в цепи');
    if (u.value < BigInt(w.frcAmount)) throw new Error('в FRC HTLC меньше оговоренного');
    const h = await rpc('getblockcount');
    if (Number(t1) < h + SWAP_T1 - 5) throw new Error('слишком близкий таймаут T1');
    w.frcHtlc = { txid, vout, value: String(u.value), refheight: u.refheight, leaf, cltv: Number(t1) }; w.t1 = Number(t1);
    // relay funds the BTC HTLC
    const bh = await btcRpc('getblockcount');
    const t2 = bh + SWAP_T2;
    const bleaf = btcHtlcLeaf({ paymentHash: w.paymentHash, claimPub: w.maker.btcPub, refundPub: w.relayBtcPub, cltv: t2 });
    const baddr = btcHtlcAddress(bleaf, BTC_HRP);
    const btcId = await btcRpc('sendtoaddress', baddr, (Number(w.btcAmount) / 1e8).toFixed(8));
    await btcMine(1);
    const braw = await btcRpc('getrawtransaction', btcId, true);
    const bvout = braw.vout.findIndex(o => o.scriptPubKey.address === baddr);
    w.btcHtlc = { txid: btcId, vout: bvout, value: String(Math.round(braw.vout[bvout].value * 1e8)), leaf: bleaf, addr: baddr, cltv: t2 }; w.t2 = t2;
    w.status = 'btc_funded'; saveSwaps();
    say(`своп ${id}: BTC HTLC профинансирован, ждём выкупа пользователем`);
    return { btcHtlc: w.btcHtlc, t2 };
  },
  // 3. the user built their BTC claim (revealing R). The relay only broadcasts it (holds no key
  //    for it) and mines a regtest block; the watcher then reads R and claims the FRC.
  async swapBtcBroadcast({ id, rawtx }) {
    const w = swaps.find(x => x.id === id); if (!w) throw new Error('нет такого свопа');
    if (w.status !== 'btc_funded') throw new Error('своп не на этой стадии');
    const btcId = await btcRpc('sendrawtransaction', rawtx);
    w.btcClaimTxid = btcId; saveSwaps();
    await btcMine(1);     // regtest: confirm now; real chains: it sits in the mempool
    say(`своп ${id}: пользователь выкупил BTC (${btcId.slice(0, 12)}…)`);
    await watchSwaps();   // immediate: read R (works at 0-conf) and settle the FRC leg
    return { btcClaim: btcId, status: w.status };
  },

  // ===== P2P SWAP BOARD: maker-priced FRC↔BTC, user-to-user. The relay coordinates and
  // watches both chains but holds NO keys and NO funds — real price discovery, non-custodial.
  // V1 direction: maker SELLS FRC for BTC (the "exit"). Maker is the initiator (holds R). =====
  // cancel/remove MY p2p offer (soft-owned by the maker's pubkey). Only if no FRC is locked yet.
  async p2pCancel({ id, makerFrcPub }) {
    const i = p2p.findIndex(x => x.id === id);
    if (i < 0) throw new Error('нет такого оффера');
    const w = p2p[i];
    if (w.maker.frcPub !== makerFrcPub) throw new Error('оффер не ваш');
    if (w.frcHtlc) throw new Error('FRC уже заперт — дождитесь завершения или возврата');
    p2p.splice(i, 1); saveP2p();
    say(`P2P ${id}: снят мейкером`);
    return { ok: true };
  },
  async p2pList() {
    const fh = await rpc('getblockcount').catch(() => 0);
    const bh = await btcRpc('getblockcount').catch(() => 0);
    return { available: btcAvail(), t1: SWAP_T1, t2: SWAP_T2, revTf: REV_TF, revTb: REV_TB, btcNet: BTC_NET, btcHrp: BTC_HRP, frcHeight: fh, btcHeight: bh,
      swaps: p2p.slice(-60).map(w => ({ id: w.id, dir: w.dir ?? 'sellFrc', status: w.status, frcAmount: w.frcAmount, btcAmount: w.btcAmount,
        maker: w.maker, taker: w.taker, paymentHash: w.paymentHash, t1: w.t1, t2: w.t2,
        frcHtlc: w.frcHtlc, btcHtlc: w.btcHtlc, preimage: w.preimage ?? null })) };
  },
  // maker posts an offer at THEIR price. makerBtcAddr = where the maker will receive BTC.
  async p2pPost({ frcAmount, btcAmount, makerFrcPub, makerBtcPub, makerBtcAddr, paymentHash }) {
    if (!btcAvail()) throw new Error('своп недоступен: нет BTC-узла');
    if (!/^[0-9a-f]{64}$/.test(paymentHash || '')) throw new Error('плохой paymentHash');
    if (!/^[0-9a-f]{66}$/.test(makerFrcPub || '') || !/^[0-9a-f]{66}$/.test(makerBtcPub || '')) throw new Error('плохие ключи');
    const frc = BigInt(frcAmount), btc = BigInt(btcAmount);
    if (frc <= 0n || btc <= 0n) throw new Error('плохие суммы');
    const id = 'p2p' + (p2pSeq++);
    const w = { id, status: 'open', frcAmount: String(frc), btcAmount: String(btc), paymentHash,
      maker: { frcPub: makerFrcPub, btcPub: makerBtcPub, btcAddr: makerBtcAddr },
      taker: null, frcHtlc: null, btcHtlc: null, preimage: null, t1: 0, t2: 0 };
    p2p.push(w); saveP2p();
    say(`P2P-оффер ${id}: продаю ${Number(frc)/1e8} FRC за ${Number(btc)/1e8} BTC`);
    return { id };
  },
  // a taker accepts: commits their receive keys. takerFrcAddr = where the taker receives FRC.
  async p2pTake({ id, takerFrcPub, takerBtcPub, takerFrcAddr }) {
    const w = p2p.find(x => x.id === id); if (!w) throw new Error('нет такого оффера');
    if (w.status !== 'open') throw new Error('оффер уже взят');
    if (!/^[0-9a-f]{66}$/.test(takerFrcPub || '') || !/^[0-9a-f]{66}$/.test(takerBtcPub || '')) throw new Error('плохие ключи');
    w.taker = { frcPub: takerFrcPub, btcPub: takerBtcPub, frcAddr: takerFrcAddr };
    w.status = 'taken'; w.takenAt = indexedHeight; saveP2p();
    say(`P2P-оффер ${id}: взят — стороны обмениваются HTLC`);
    return { id, maker: w.maker, frcAmount: w.frcAmount, btcAmount: w.btcAmount, paymentHash: w.paymentHash };
  },
  // maker funded the FRC HTLC (claim=taker, refund=maker, cltv=T1). Relay VERIFIES on fc-nv3,
  // then hands the taker the BTC HTLC address to fund (claim=maker, refund=taker, cltv=T2<T1).
  async p2pFrcFunded({ id, txid, vout, t1 }) {
    const w = p2p.find(x => x.id === id); if (!w) throw new Error('нет такого оффера');
    if (w.status !== 'taken') throw new Error('оффер не на этой стадии');
    await catchUp();
    const leaf = htlcLeaf({ paymentHash: w.paymentHash, claimPub: w.taker.frcPub, refundPub: w.maker.frcPub, cltv: Number(t1) });
    const u = utxos.get(`${txid}:${vout}`);
    if (!u || u.assetTag !== null || u.spk !== htlcSpk(leaf)) throw new Error('FRC HTLC не найден/не совпал');
    if (u.value < BigInt(w.frcAmount)) throw new Error('в FRC HTLC меньше оговоренного');
    const h = await rpc('getblockcount');
    if (Number(t1) < h + SWAP_T1 - 5) throw new Error('слишком близкий таймаут T1');
    const bh = await btcRpc('getblockcount'); const t2 = bh + SWAP_T2;
    const bleaf = btcHtlcLeaf({ paymentHash: w.paymentHash, claimPub: w.maker.btcPub, refundPub: w.taker.btcPub, cltv: t2 });
    w.frcHtlc = { txid, vout, value: String(u.value), refheight: u.refheight, leaf, cltv: Number(t1) }; w.t1 = Number(t1);
    w.btcHtlc = { addr: btcHtlcAddress(bleaf, BTC_HRP), leaf: bleaf, cltv: t2, value: w.btcAmount, txid: null, vout: null }; w.t2 = t2;
    w.status = 'frc_funded'; saveP2p();
    await watchAddress(w.btcHtlc.addr);   // start watching so the payment is auto-detected (no txid needed)
    say(`P2P ${id}: FRC заперт — тейкер финансирует BTC HTLC ${w.btcHtlc.addr}`);
    return { btcHtlc: w.btcHtlc };
  },
  // taker funded the BTC HTLC from their own wallet — reports the txid; relay verifies on-chain.
  async p2pBtcFunded({ id, btcTxid }) {
    const w = p2p.find(x => x.id === id); if (!w) throw new Error('нет такого оффера');
    if (w.status !== 'frc_funded') throw new Error('оффер не на этой стадии');
    const tx = await btcRpc('getrawtransaction', btcTxid, true).catch(() => null);
    if (!tx) throw new Error('BTC-транзакция не найдена');
    const vout = tx.vout.findIndex(o => o.scriptPubKey.address === w.btcHtlc.addr);
    if (vout < 0) throw new Error('транзакция не платит на HTLC-адрес');
    if (BigInt(Math.round(tx.vout[vout].value * 1e8)) < BigInt(w.btcAmount)) throw new Error('в BTC HTLC меньше оговоренного');
    w.btcHtlc.txid = btcTxid; w.btcHtlc.vout = vout; w.btcHtlc.value = String(Math.round(tx.vout[vout].value * 1e8));
    w.status = 'btc_funded'; saveP2p();
    say(`P2P ${id}: BTC заперт — мейкер забирает BTC (раскроет секрет)`);
    return { ok: true };
  },
  // maker built their BTC claim (reveals R). Relay broadcasts; the watcher surfaces R for the taker.
  async p2pBtcClaim({ id, rawtx }) {
    const w = p2p.find(x => x.id === id); if (!w) throw new Error('нет такого оффера');
    if (w.status !== 'btc_funded') throw new Error('оффер не на этой стадии');
    const btcId = await btcRpc('sendrawtransaction', rawtx);
    w.btcClaimTxid = btcId; await btcMine(1); saveP2p();
    const R = await preimageFromTx(btcId, w.paymentHash);
    if (R) { w.preimage = R; w.status = 'btc_claimed'; saveP2p(); }
    say(`P2P ${id}: мейкер забрал BTC (${btcId.slice(0, 12)}…) — секрет раскрыт`);
    return { btcClaim: btcId, preimage: w.preimage };
  },
  // taker reports they claimed the FRC with R (relay marks done; the coin is theirs on-chain).
  async p2pDone({ id }) {
    const w = p2p.find(x => x.id === id); if (!w) throw new Error('нет такого оффера');
    if (!utxos.has(`${w.frcHtlc.txid}:${w.frcHtlc.vout}`)) { w.status = 'done'; saveP2p(); }
    return { status: w.status };
  },

  // ===== REVERSE direction: maker SELLS BTC for FRC. Maker holds R and funds the BTC HTLC FIRST
  // (claim=taker, refund=maker, cltv=TB — the FAR leg); the taker funds the FRC HTLC (claim=maker,
  // refund=taker, cltv=TF — the NEAR leg); the maker claims FRC (reveals R on fc-nv3); the taker
  // claims BTC with R. Timelock ordering (TB later than TF) mirrors the forward path and likewise
  // assumes prompt completion. The relay holds no keys and no funds here either. =====
  async p2pPostB({ frcAmount, btcAmount, makerFrcPub, makerBtcPub, makerFrcAddr, paymentHash }) {
    if (!btcAvail()) throw new Error('своп недоступен: нет BTC-узла');
    if (!/^[0-9a-f]{64}$/.test(paymentHash || '')) throw new Error('плохой paymentHash');
    if (!/^[0-9a-f]{66}$/.test(makerFrcPub || '') || !/^[0-9a-f]{66}$/.test(makerBtcPub || '')) throw new Error('плохие ключи');
    const frc = BigInt(frcAmount), btc = BigInt(btcAmount);
    if (frc <= 0n || btc <= 0n) throw new Error('плохие суммы');
    const id = 'p2p' + (p2pSeq++);
    const w = { id, dir: 'sellBtc', status: 'open', frcAmount: String(frc), btcAmount: String(btc), paymentHash,
      maker: { frcPub: makerFrcPub, btcPub: makerBtcPub, frcAddr: makerFrcAddr },
      taker: null, frcHtlc: null, btcHtlc: null, preimage: null, t1: 0, t2: 0 };
    p2p.push(w); saveP2p();
    say(`P2P-оффер ${id}: продаю ${Number(btc)/1e8} BTC за ${Number(frc)/1e8} FRC`);
    return { id };
  },
  async p2pTakeB({ id, takerFrcPub, takerBtcPub, takerBtcAddr }) {
    const w = p2p.find(x => x.id === id); if (!w || w.dir !== 'sellBtc') throw new Error('нет такого оффера');
    if (w.status !== 'open') throw new Error('оффер уже взят');
    if (!/^[0-9a-f]{66}$/.test(takerFrcPub || '') || !/^[0-9a-f]{66}$/.test(takerBtcPub || '')) throw new Error('плохие ключи');
    w.taker = { frcPub: takerFrcPub, btcPub: takerBtcPub, btcAddr: takerBtcAddr };
    w.status = 'taken'; w.takenAt = indexedHeight; saveP2p();
    say(`P2P-оффер ${id}: взят (обратный) — стороны обмениваются HTLC`);
    return { id, maker: w.maker, frcAmount: w.frcAmount, btcAmount: w.btcAmount, paymentHash: w.paymentHash };
  },
  // maker funded the BTC HTLC (claim=taker, refund=maker, cltv=tb). Relay verifies on-chain, then
  // hands back the FRC HTLC terms (claim=maker, refund=taker, cltv=TF) for the taker to fund.
  async p2pBtcFundedB({ id, btcTxid, tb }) {
    const w = p2p.find(x => x.id === id); if (!w || w.dir !== 'sellBtc') throw new Error('нет такого оффера');
    if (w.status !== 'taken') throw new Error('оффер не на этой стадии');
    const bh = await btcRpc('getblockcount');
    if (Number(tb) < bh + REV_TB - 5) throw new Error('слишком близкий таймаут BTC');
    const bleaf = btcHtlcLeaf({ paymentHash: w.paymentHash, claimPub: w.taker.btcPub, refundPub: w.maker.btcPub, cltv: Number(tb) });
    const baddr = btcHtlcAddress(bleaf, BTC_HRP);
    const tx = await btcRpc('getrawtransaction', btcTxid, true).catch(() => null);
    if (!tx) throw new Error('BTC-транзакция не найдена');
    const vout = tx.vout.findIndex(o => o.scriptPubKey.address === baddr);
    if (vout < 0) throw new Error('транзакция не платит на HTLC-адрес');
    if (BigInt(Math.round(tx.vout[vout].value * 1e8)) < BigInt(w.btcAmount)) throw new Error('в BTC HTLC меньше оговоренного');
    const fh = await rpc('getblockcount'); const tf = fh + REV_TF;
    const fleaf = htlcLeaf({ paymentHash: w.paymentHash, claimPub: w.maker.frcPub, refundPub: w.taker.frcPub, cltv: tf });
    w.btcHtlc = { addr: baddr, leaf: bleaf, cltv: Number(tb), value: String(Math.round(tx.vout[vout].value * 1e8)), txid: btcTxid, vout }; w.t2 = Number(tb);
    w.frcHtlc = { addr: null, spk: htlcSpk(fleaf), leaf: fleaf, cltv: tf, txid: null, vout: null, value: null }; w.t1 = tf;
    w.status = 'btc_funded_rev'; saveP2p();
    say(`P2P ${id}: BTC заперт мейкером — тейкер финансирует FRC HTLC ${htlcSpk(fleaf).slice(0, 12)}…`);
    return { frcHtlc: { spk: htlcSpk(fleaf), leaf: fleaf, cltv: tf } };
  },
  // taker funded the FRC HTLC (claim=maker, refund=taker, cltv=tf). Relay verifies on fc-nv3.
  async p2pFrcFundedB({ id, txid, vout }) {
    const w = p2p.find(x => x.id === id); if (!w || w.dir !== 'sellBtc') throw new Error('нет такого оффера');
    if (w.status !== 'btc_funded_rev') throw new Error('оффер не на этой стадии');
    await catchUp();
    const u = utxos.get(`${txid}:${vout}`);
    if (!u || u.assetTag !== null || u.spk !== w.frcHtlc.spk) throw new Error('FRC HTLC не найден/не совпал');
    if (u.value < BigInt(w.frcAmount)) throw new Error('в FRC HTLC меньше оговоренного');
    w.frcHtlc.txid = txid; w.frcHtlc.vout = vout; w.frcHtlc.value = String(u.value); w.frcHtlc.refheight = u.refheight;
    w.status = 'frc_funded_rev'; saveP2p();
    say(`P2P ${id}: FRC заперт тейкером — мейкер забирает FRC (раскроет секрет)`);
    return { ok: true };
  },
  // maker built their FRC claim (reveals R on fc-nv3). Relay broadcasts + mines; surfaces R.
  async p2pFrcClaimB({ id, rawtx }) {
    const w = p2p.find(x => x.id === id); if (!w || w.dir !== 'sellBtc') throw new Error('нет такого оффера');
    if (w.status !== 'frc_funded_rev') throw new Error('оффер не на этой стадии');
    await rpc('generateblock', mineAddr, [rawtx]); await catchUp();
    w.frcClaimTxid = computeTxid(parseTx(rawtx));
    const R = frcPreimageFromRaw(rawtx, w.paymentHash);
    if (R) { w.preimage = R; w.status = 'frc_claimed_rev'; saveP2p(); }
    say(`P2P ${id}: мейкер забрал FRC (${w.frcClaimTxid.slice(0, 12)}…) — секрет раскрыт`);
    return { preimage: w.preimage };
  },
  // taker reports they claimed the BTC with R (relay marks done once the BTC HTLC coin is spent).
  async p2pDoneB({ id }) {
    const w = p2p.find(x => x.id === id); if (!w || w.dir !== 'sellBtc') throw new Error('нет такого оффера');
    w.status = 'done'; saveP2p();
    return { status: w.status };
  },

  async name({ tag }) { return { name: assets.get(tag)?.name ?? null }; },
};

const server = createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Content-Type': 'application/json; charset=utf-8' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    const m = /^\/api\/(\w+)$/.exec(req.url ?? '');
    if (!m || !(m[1] in api)) { res.writeHead(404, cors); return res.end('{"error":"not found"}'); }
    let body = {};
    if (req.method === 'POST') body = await new Promise(ok => { let d = ''; req.on('data', c => d += c); req.on('end', () => ok(d ? JSON.parse(d) : {})); });
    const out = await api[m[1]](body);
    res.writeHead(200, cors);
    res.end(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? String(v) : v));
  } catch (e) { res.writeHead(400, cors); res.end(JSON.stringify({ error: e.message })); }
});
await bootstrap();
server.listen(LISTEN, '0.0.0.0', () => console.log(`market server on :${LISTEN}, chain ${DATADIR}, indexed to ${indexedHeight}`));
