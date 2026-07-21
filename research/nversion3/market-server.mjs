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
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { serializeTx, parseTx, txid as computeTxid, NV3_TX_VERSION } from '../../core/tx.mjs';
import { loadOrCreateVapid, sendPush } from './webpush.mjs';
import { decodeAssetSpk } from '../../core/asset-spk.mjs';
import { makeTokenReveal, parseTokenReveal, opReturnScript } from '../../core/nv3wire.mjs';
import { tokenSetHash } from '../../core/asset-spk.mjs';
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
// ===== v2 (taker-first) timeouts. ANTI-GRIEFING ORDER: the TAKER holds the secret R and funds
// FIRST (their leg gets the FAR timeout); the maker responds only to a CONFIRMED real commitment
// (their leg gets the NEAR timeout). Taking an offer and vanishing now costs the taker a real
// on-chain payment — the maker locks nothing until then. Wall-clock invariant per direction:
// the maker's NEAR leg must expire well before the taker's FAR leg.
// How deep the counterparty's BTC funding must be buried before WE act on it (lock our asset /
// reveal R). 0-conf is fine on test nets, but on MAINNET a buyer could RBF their funding away
// AFTER our response and steal the swap — hence ≥2 by default there.
const BTC_MINCONF = Number(process.env.BTC_MINCONF ?? (BTC_NET === 'main' ? 2 : 0));

// ---- v2 timeouts: declared in WALL-CLOCK, converted to blocks per chain ----
// Blocks are NOT a unit of time: an FRC block is ~20 s on this regtest (our miner tick) but 10 min
// on mainnet — a constant "60 blocks" silently becomes 10 hours there. So the windows below are
// stated in HOURS and divided by each chain's block time.
const FRC_NET = process.env.FRC_NET ?? 'regtest';           // regtest | test | main
const IS_REGTEST = FRC_NET === 'regtest';                   // gates the miner tick + on-demand mining
// The faucet also runs on our public signet (the relay wallet is fed by the signet miner);
// there it is rate-limited per address. Mainnet/testnet stay pure indexers.
const HAS_FAUCET = IS_REGTEST || FRC_NET === 'signet';
const faucetLog = new Map();                                // address → last-payout ms (public faucet)
const FRC_BLOCK_SEC = Number(process.env.FRC_BLOCK_SEC ?? (IS_REGTEST ? MINE_EVERY_MS / 1000 : 600));
const BTC_BLOCK_SEC = Number(process.env.BTC_BLOCK_SEC ?? (BTC_ONDEMAND ? 30 : 600));
// FUNDER-first (the secret holder) gets the FAR window; the RESPONDER gets the NEAR one. The gap
// between them is the safety margin: after the near leg expires, the responder must still have
// ample time to claim with the revealed R before the far leg refunds.
const H_FAR_HOURS = Number(process.env.SWAP_FAR_HOURS ?? 4);    // fwd: taker's BTC · rev: taker's FRC
const H_NEAR_HOURS = Number(process.env.SWAP_NEAR_HOURS ?? 1);  // fwd: maker's FRC · rev: maker's BTC
const blocksFor = (hours, blockSec, min) => Math.max(min, Math.ceil((hours * 3600) / blockSec));
const V2_BTC_FAR = blocksFor(H_FAR_HOURS, BTC_BLOCK_SEC, 6);     // fwd taker's BTC HTLC
const V2_FRC_NEAR = blocksFor(H_NEAR_HOURS, FRC_BLOCK_SEC, 6);   // fwd maker's FRC HTLC
const V2_FRC_FAR = blocksFor(H_FAR_HOURS + 2, FRC_BLOCK_SEC, 12); // rev taker's FRC/asset HTLC (+2h: the FRC chain confirms slower for the maker's final claim)
const V2_BTC_NEAR = blocksFor(H_NEAR_HOURS, BTC_BLOCK_SEC, 3);   // rev maker's BTC HTLC
// how far a reported cltv may drift from our expectation (client tip lag, slow ticks): ±10 min
const FRC_SLACK = Math.max(2, Math.ceil(600 / FRC_BLOCK_SEC));
const BTC_SLACK = Math.max(2, Math.ceil(600 / BTC_BLOCK_SEC));
// SAFETY INVARIANT: a responder who learns R at the very last moment of the NEAR window must still
// be able to confirm their claim before the FAR window refunds the funder. Refuse to run otherwise.
{
  const nearFwdH = (V2_FRC_NEAR * FRC_BLOCK_SEC) / 3600, farFwdH = (V2_BTC_FAR * BTC_BLOCK_SEC) / 3600;
  const nearRevH = (V2_BTC_NEAR * BTC_BLOCK_SEC) / 3600, farRevH = (V2_FRC_FAR * FRC_BLOCK_SEC) / 3600;
  for (const [dir, near, far] of [['forward', nearFwdH, farFwdH], ['reverse', nearRevH, farRevH]])
    if (far < near * 2) throw new Error(`таймауты небезопасны (${dir}): near=${near.toFixed(1)}ч far=${far.toFixed(1)}ч — far должен быть ≥ 2×near`);
  console.log(`swap timeouts — forward: near ${nearFwdH.toFixed(1)}h (${V2_FRC_NEAR} frc blk) / far ${farFwdH.toFixed(1)}h (${V2_BTC_FAR} btc blk); `
    + `reverse: near ${nearRevH.toFixed(1)}h (${V2_BTC_NEAR} btc blk) / far ${farRevH.toFixed(1)}h (${V2_FRC_FAR} frc blk)`);
}
const HOST_TAG = '00'.repeat(20);

const sha256 = b => createHash('sha256').update(b).digest();
const hash256 = b => sha256(sha256(b));
const ripemd160 = b => createHash('ripemd160').update(b).digest();
const hash160 = b => ripemd160(sha256(b));
const rev = hex => hex.match(/../g).reverse().join('');

let cookie = '';
// the node's cookie lives in a per-chain subdir of the datadir (freicoind: testnet → "testnet")
const FRC_SUBDIR = { regtest: 'regtest/', test: 'testnet/', signet: 'signet/', main: '' }[FRC_NET] ?? 'regtest/';
const refreshCookie = () => { cookie = Buffer.from(readFileSync(`${DATADIR}/${FRC_SUBDIR}.cookie`)).toString('base64'); };
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

// v2 maker liveness: last time each maker key polled us (p2pPing / posting). Memory-only — the
// bootstrap seeds it for loaded offers so a relay restart grants every maker a fresh grace window.
const makerSeen = new Map();
const heartbeat = pub => { if (pub) makerSeen.set(pub, Date.now()); };

const addU = (op, u) => { utxos.set(op, u); (spkIndex.get(u.spk) ?? spkIndex.set(u.spk, new Set()).get(u.spk)).add(op); };
const delU = op => { const u = utxos.get(op); if (u) { utxos.delete(op); spkIndex.get(u.spk)?.delete(op); } };

async function indexBlock(h) {
  const hash = await rpc('getblockhash', h);
  const blk = await rpc('getblock', hash, 2);
  for (const tx of blk.tx) {
    const isCoinbase = !!tx.vin[0]?.coinbase || !tx.vin[0]?.txid;
    for (const vin of tx.vin) if (vin.txid) delU(`${vin.txid}:${vin.vout}`);
    // record the SPENDER of each p2p FRC-HTLC (the claim — or refund — tx): clients rebuilding
    // trade history on a fresh device can't re-derive an ASSET claim's txid (its fee coin was picked
    // from the claimant's then-current utxo set), so the relay remembers it for them. Checking the
    // ARCHIVE too makes the boot-time chain reindex a free backfill for already-completed swaps.
    for (const vin of tx.vin) if (vin.txid) {
      const w = p2p.find(x => x.frcHtlc && x.frcHtlc.txid === vin.txid && x.frcHtlc.vout === vin.vout)
        ?? p2pArchive.find(x => x.frcHtlc && x.frcHtlc.txid === vin.txid && x.frcHtlc.vout === vin.vout);
      if (w && !w.frcSpendTxid) { w.frcSpendTxid = tx.txid; saveP2p(); }
      // v2 forward: the taker's FRC/asset claim REVEALS R right here in the spend witness — surface
      // it so the maker can claim the BTC side. (A refund/coop spend carries no matching preimage.)
      if (w && w.v === 2 && w.status === 'frc_funded' && !w.preimage && w.paymentHash) {
        for (const item of (vin.txinwitness || []))
          if (/^[0-9a-f]{64}$/.test(item) && sha256(Buffer.from(item, 'hex')).toString('hex') === w.paymentHash) {
            w.preimage = item; w.status = 'frc_claimed'; saveP2p();
            say(`P2P ${w.id}: тейкер забрал ${w.assetTag ? 'актив' : 'FRC'} — секрет раскрыт, мейкер забирает BTC`);
            pushSwap(w, 'maker', 'Секрет раскрыт — откройте кошелёк, чтобы забрать BTC');
          }
      }
      // v2 reverse: the maker's FRC/asset claim (with R) completes the swap
      if (w && w.v === 2 && w.dir === 'sellBtc' && w.status === 'btc_claimed_rev') { w.status = 'done'; saveP2p(); }
    }
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
    // nVersion=3 tokens: recover the per-output token STRINGS from this tx's FRT1 reveal, kept
    // only where they hash to the output's own commitment (self-certifying; a taker needs the
    // strings to build the reveal when buying a token coin on the DEX).
    let tokMap = new Map();
    for (const o of tx.vout) {
      const spk = o.scriptPubKey.hex;
      if (!spk.startsWith('6a')) continue;
      const b = Buffer.from(spk.slice(2), 'hex');
      const payload = b[0] >= 1 && b[0] <= 75 ? b.subarray(1, 1 + b[0]) : b[0] === 0x4c ? b.subarray(2, 2 + b[1]) : null;
      if (!payload || payload.subarray(0, 4).toString('hex') !== '46525431') continue;
      try {
        const { outputs } = parseTokenReveal(payload.toString('hex'));
        for (const [idx, ts] of outputs) {
          const dec = decodeAssetSpk(tx.vout[idx]?.scriptPubKey?.hex ?? '');
          if (dec?.tokenHash && tokenSetHash(ts) === dec.tokenHash) tokMap.set(idx, ts);
        }
      } catch { /* malformed reveal — ignore */ }
      break;
    }
    tx.vout.forEach((o, n) => {
      if (o.scriptPubKey.hex.startsWith('6a')) return;   // OP_RETURN: unspendable
      // nVersion=3 EXTENSION-OUTPUT: the asset tag rides in the scriptPubKey. Index by the BASE
      // spk (tag stripped) so a wallet query by its base address matches, and derive the tag from
      // the script (RPC's assetTag is a convenience mirror but the script is authoritative).
      const dec = decodeAssetSpk(o.scriptPubKey.hex);
      const baseSpk = dec ? dec.baseSpk : o.scriptPubKey.hex;
      const tag = dec?.assetTag ?? (o.assetTag ? rev(o.assetTag) : null);
      const u = { spk: baseSpk, assetTag: tag, value: BigInt(Math.round(o.value * 1e8)), refheight: tx.lockheight,
        ...(isCoinbase ? { coinbase: true } : {}),
        ...(dec?.tokenHash ? { tokenHash: dec.tokenHash, tokens: tokMap.get(n) ?? [] } : {}) };
      addU(`${tx.txid}:${n}`, u);
      if (tag && assets.has(tag) && h === (assets.get(tag).issuedAt ?? h)) assets.get(tag).supply += u.value;
    });
  }
  indexedHeight = h;
}
// INDEXING WINDOW. The utxo map lives in memory and only ever needs the coins a SWAP touches (HTLC
// outpoints + their spenders), all of which are younger than the oldest live swap. Replaying from
// genesis is fine on a 300-block regtest and impossible on mainnet — so start from the oldest
// height we still care about: the earliest live swap/offer, else a window back from the tip.
const INDEX_WINDOW = Number(process.env.NV3_INDEX_WINDOW ?? (FRC_NET === 'regtest' ? 1e9 : 2000));
function indexStart(tip) {
  const refs = [];
  for (const w of p2p) { const r = w.frcHtlc?.refheight ?? w.takenAt; if (r != null) refs.push(Number(r)); }
  for (const o of book) if (o.give?.refheight != null) refs.push(Number(o.give.refheight));
  for (const w of swaps) if (w.frcHtlc?.refheight != null) refs.push(Number(w.frcHtlc.refheight));
  const oldest = refs.length ? Math.min(...refs) : Infinity;
  const windowed = Math.max(0, tip - INDEX_WINDOW);
  return Math.max(0, Math.min(oldest, windowed));
}
async function catchUp() {
  const tip = await rpc('getblockcount');
  if (indexedHeight < 0) {   // cold start: skip ahead to the window instead of replaying from genesis
    const from = indexStart(tip);
    if (from > 0) { indexedHeight = from - 1; say(`индексация с высоты ${from} (окно ${INDEX_WINDOW})`); }
  }
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
// 0-fee: matcher crosses carry asset legs that can be dust, and Freicoin policy admits dust
// outputs only in fee-less txs (our node relays and mines 0-fee).
const FEE = 0n;
const opPrev = op => ({ txid: rev(op.split(':')[0]), vout: +op.split(':')[1] });
function repointAfterFill(o, changeOp, h) {
  const c = utxos.get(changeOp);
  const cpv = c ? pvOf(c, h) : 0n;
  if (c && c.spk === o.desc.changeScript && cpv > 0n && cpv >= BigInt(o.desc.minFill)) {
    o.giveOutpoint = changeOp; o.witness = null; o.ladder = []; o.needsResign = true; o.status = 'open';
    notifyResign(o);
  } else o.status = 'filled';
  saveBook();
}
// A partial fill leaves the remainder UNSIGNED (no pre-signed rung can cover a fresh change
// outpoint) — an offline maker's offer is dead until they return, so ping them.
const notifyResign = o =>
  notifyPub(o.makerPub, { id: o.id, status: 'needsResign', title: `Freimarkets · оффер #${o.id}`,
    body: 'частичный выкуп — остаток снят с торгов до вашей переподписи (откройте кошелёк)' });
// Put a relay-built tx on the chain: regtest mines it straight in (deterministic dev loop);
// a real chain broadcasts to the mempool and lets the (signet) miner confirm it.
async function submitTx(raw) {
  if (IS_REGTEST) await rpc('generateblock', mineAddr, [raw]);
  else await rpc('sendrawtransaction', raw);
}
async function ensureMatcherFuel() {
  for (const op of spkIndex.get(TRUE_SPK) ?? []) { const u = utxos.get(op); if (u && !u.assetTag && u.value >= FEE + 10000n) return; }
  try {
    const dec = await rpc('decodescript', TRUE_SPK);
    await rpc('sendtoaddress', dec.address, '0.01');
    if (IS_REGTEST) await rpc('generatetoaddress', 1, mineAddr);
    await catchUp();
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
      await submitTx(raw);
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
    // a partial-offer CHILD that was taken but never funded within grace: hand its reserved amount
    // back to the parent offer's `remaining` before removing it, so the offer keeps selling.
    // v2: at 'taken' the HTLC TERMS exist but no coin — zombie = nothing FUNDED (txid), any format
    const zombie = w.status === 'taken' && !w.frcHtlc?.txid && !w.btcHtlc?.txid && w.takenAt != null && indexedHeight - w.takenAt > GRACE;
    // v2 heartbeat: an open offer whose maker hasn't polled the relay in 24 h is abandoned —
    // retire it so a taker's first-mover funding isn't stranded. A DAY (not the old 40 min):
    // web-push wakes a maker whose tab is closed, so a human maker stays reachable without a
    // live heartbeat; and even in the worst case the taker's BTC auto-refunds at t2 (~4 h).
    if (w.v === 2 && w.status === 'open' && w.maker?.frcPub
      && Date.now() - (makerSeen.get(w.maker.frcPub) ?? 0) > 24 * 3600e3) { w.status = 'expired'; changed = true; }
    if (zombie && w.parent) {
      const o = p2p.find(x => x.id === w.parent && x.kind === 'offer');
      // restore in the SOLD unit: forward offers track remaining in FRC/asset, reverse in BTC
      if (o) { const back = w.dir === 'sellBtc' ? w.btcAmount : w.frcAmount; o.remaining = String(BigInt(o.remaining) + BigInt(back)); if (o.status === 'closed') o.status = 'open'; }
      p2p.splice(i, 1); changed = true; continue;
    }
    // an offer container with nothing left and no live children → retire it
    if (w.kind === 'offer' && BigInt(w.remaining) <= 0n && !p2p.some(x => x.parent === w.id)) { p2p.splice(i, 1); changed = true; continue; }
    if (w.kind === 'offer') continue;   // otherwise an offer container is never itself "settled"
    const settled = ['done', 'cancelled', 'expired'].includes(w.status);
    const takerClaimed = w.status === 'btc_claimed' && w.frcHtlc && !utxos.has(`${w.frcHtlc.txid}:${w.frcHtlc.vout}`);
    const frcLive = w.frcHtlc && utxos.has(`${w.frcHtlc.txid}:${w.frcHtlc.vout}`);
    // a funded swap whose locked coin is GONE without reaching btc_claimed (coop-cancel or timeout
    // refund) can never proceed — it is a dead board row, not a trade (nothing to archive)
    const frcGone = ['frc_funded', 'frc_funded_rev'].includes(w.status) && w.frcHtlc && !frcLive;
    // ancient non-terminal swap with NOTHING locked on the FRC side (e.g. a BTC-side leg from a
    // wiped/renamed BTC chain era): unfinishable, stop advertising it
    const stale = w.takenAt != null && indexedHeight - w.takenAt > 1500 && !frcLive;
    if (settled || takerClaimed || zombie || frcGone || stale) {
      // completed swaps go to the archive (clients rebuild trade history from it); dead ones just go
      if (w.status === 'done' || takerClaimed) p2pArchive.push({ ...w, archivedAt: Date.now() });
      p2p.splice(i, 1); changed = true;
    }
  }
  if (changed) saveP2p();
}
async function watchP2p() {
  reconcileP2p();
  if (!btcAvail()) return;
  const bh = await btcRpc('getblockcount').catch(() => 0);
  for (const w of p2p) {
    try {
      // DEAD-SWAP BURIAL: once the BTC height passes the funded leg's refund height (t2) with no
      // preimage revealed, the taker's wallet auto-refunds their BTC and the swap can never finish.
      // Without this the board row lingers in btc_funded forever: the maker's client keeps trying
      // to lock FRC and (rightly) refuses on unsafe timelocks, the taker sees a refund they can't
      // explain, and the offer never frees. Expire it; reconcileP2p prunes it on the next pass.
      if (w.v === 2 && ['taken', 'btc_funded'].includes(w.status) && w.t2 && bh > w.t2 && !w.preimage) {
        w.status = 'expired'; saveP2p();
        say(`P2P ${w.id}: истёк — BTC-таймлок (${w.t2}) прошёл, секрет не раскрыт; BTC вернутся покупателю по таймауту`);
        pushSwap(w, 'maker', 'своп истёк — покупатель вернул свой BTC по таймауту; оффер можно выставить заново');
        pushSwap(w, 'taker', 'своп истёк — продавец не успел; ваши BTC вернулись по таймауту');
        continue;
      }
      // auto-detect the taker's BTC funding to the HTLC address (mempool + confirmed) — no txid.
      // v2 (taker-first): the funding arrives at status 'taken'; legacy in-flight swaps funded at
      // 'frc_funded'. Same detection, different starting state.
      if (((w.v === 2 && w.status === 'taken' && w.dir !== 'sellBtc') || (w.v !== 2 && w.status === 'frc_funded')) && w.btcHtlc && !w.btcHtlc.txid) {
        // Self-heal detection. The take-time watchAddress import can silently fail (RPC hiccup,
        // wallet not yet loaded) OR import with timestamp:'now' only AFTER the taker's funding
        // already confirmed — either way listunspent stays permanently blind and the swap hangs
        // at 'taken' with the UI (wrongly) asking to pay again, even though the BTC is on-chain.
        // Re-import if the address isn't watched, and kick a bounded, debounced rescan so an
        // already-confirmed funding surfaces on a later poll. btcDeep dedups so this costs a
        // single import+rescan per address across the swap's life.
        if (!btcDeep.has(w.btcHtlc.addr)) {
          const known = await btcWatch('getaddressinfo', w.btcHtlc.addr).then(i => i && (i.ismine || i.iswatchonly)).catch(() => false);
          if (!known) await watchAddress(w.btcHtlc.addr).catch(() => {});
          btcDeepScan([w.btcHtlc.addr]);   // debounced; retries next tick if a rescan is already in flight
        }
        // BTC_MINCONF gates the transition: the maker responds only to a funding that can no
        // longer be RBF'd out from under them
        const utxo = await btcWatch('listunspent', BTC_MINCONF, 9999999, [w.btcHtlc.addr]).catch(() => []);
        const hit = (utxo || []).find(u => BigInt(Math.round(u.amount * 1e8)) >= BigInt(w.btcAmount));
        if (hit) {
          w.btcHtlc.txid = hit.txid; w.btcHtlc.vout = hit.vout; w.btcHtlc.value = String(Math.round(hit.amount * 1e8));
          w.status = 'btc_funded'; saveP2p();
          say(`P2P ${w.id}: BTC-платёж определён автоматически (${hit.txid.slice(0, 12)}…)`);
          pushSwap(w, 'maker', 'BTC покупателя подтверждён — откройте кошелёк, чтобы отправить FRC');
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
        await submitTx(c.rawtx); await catchUp();
        w.status = 'done'; saveSwaps();
        say(`своп ${w.id}: завершён — FRC получены релеем, BTC у пользователя ✅`);
      } else if ((w.status === 'created' || w.status === 'btc_funded') && w.t1 && h > w.t1 + 2) {
        w.status = 'expired'; saveSwaps();
      }
    } catch (e) { say(`своп ${w.id}: ` + String(e.message).slice(0, 60)); }
  }
}
async function preimageFromTx(txid, paymentHash) {
  // works whether the claim is unconfirmed (mempool) or mined — btcTx reads both (prune-safe)
  const tx = await btcTx(txid);
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

// ---- BTC fee rate (sat/vB), from the node's own estimator ----
// A swap's claim MUST confirm before its timelock: an under-priced claim that sticks in the mempool
// is how atomic swaps actually lose money. We target confirmation within a few blocks, clamp to a
// sane band, and cache briefly (every client polls this on every drive cycle).
const FEE_TARGET_BLOCKS = Number(process.env.BTC_FEE_TARGET ?? 3);
const FEE_MIN = Number(process.env.BTC_FEE_MIN ?? 1);       // sat/vB — signet/regtest floor
const FEE_MAX = Number(process.env.BTC_FEE_MAX ?? 100);     // sanity cap: never burn more than this
let feeCache = { at: 0, rate: FEE_MIN };
async function btcFeeRate() {
  if (Date.now() - feeCache.at < 60e3) return feeCache.rate;
  let rate = FEE_MIN, floorVb = FEE_MIN;
  try {
    // The mempool floor is the honest current minimum-to-relay; on a calm/low-activity chain
    // (signet, regtest, a quiet mainnet) it IS the realistic fee — near-empty blocks confirm it
    // in the next block.
    const mi = await btcRpcOn('', 'getmempoolinfo').catch(() => null);
    floorVb = mi?.mempoolminfee > 0 ? (mi.mempoolminfee * 1e8) / 1000 : FEE_MIN;
    if (BTC_NET === 'main') {
      // Real fee market: smartfee targets confirmation within FEE_TARGET_BLOCKS. Floor it at the
      // mempool minimum so even a stale/low estimate still relays.
      const r = await btcRpcOn('', 'estimatesmartfee', FEE_TARGET_BLOCKS, 'ECONOMICAL');
      rate = Math.max(r?.feerate > 0 ? (r.feerate * 1e8) / 1000 : floorVb, floorVb);
    } else {
      // Test chains: smartfee wildly over-pads at short targets (signet returns ~250 sat/vB for the
      // very 1 sat/vB that actually confirms), so price just above the honest mempool floor instead.
      rate = floorVb * 1.5;
    }
  } catch {}
  // keep CENTS of precision: consumers ceil at the FINAL sat amount (rate × vbytes), so rounding
  // the rate itself to whole sat/vB (2.01 → 3) silently over-paid every swap tx by up to ~50%
  rate = Math.min(FEE_MAX, Math.max(FEE_MIN, Math.ceil(rate * 100) / 100));
  // round off FP noise before ceiling: 0.00001*1e8/1000 === 1.0000000000000002, and a naive
  // ceil would report a 2 sat/vB "floor" on a 1 sat/vB mempool
  feeCache = { at: Date.now(), rate, floor: Math.max(1, Math.ceil(Math.round(floorVb * 1e6) / 1e6)) };
  return rate;
}

// Smallest possible BTC side of a swap: enough to cover its two on-chain legs (funding ~200 vB +
// claim ~170 vB) PLUS one deliverable satoshi. Below this the fee consumes the whole amount and the
// taker nets nothing. Dust (546) is a hard floor regardless. (SWAP_FEE_RATIO is retained only for
// back-compat env parsing; the floor is now the bare round-trip fee + 1 sat, not a multiple of it.)
const SWAP_FEE_RATIO = Number(process.env.SWAP_FEE_RATIO ?? 20);
// Launch training wheels: an optional HARD CAP on a swap's BTC side (sats). Set on the mainnet
// relay while the exchange is young — a bug should cost someone lunch, not a fortune. 0 = no cap.
const MAX_SWAP = BigInt(process.env.BTC_MAX_SWAP ?? 0);
const checkMaxSwap = btc => { if (MAX_SWAP > 0n && btc > MAX_SWAP) throw new Error(`слишком крупная сделка: BTC-сторона > ${MAX_SWAP} сат (стартовый лимит биржи)`); };
async function minSwapSats() {
  const rate = await btcFeeRate().catch(() => FEE_MIN);
  const roundTrip = BigInt(Math.ceil(rate * (200 + 170)));   // funding + claim network fee
  const min = roundTrip + 1n;                                 // + one deliverable satoshi (min transfer unit)
  return min > 546n ? min : 546n;
}
// a watch-only wallet the relay uses to auto-detect HTLC funding (no keys, no rescan)
const WATCH = process.env.BTC_WATCH_WALLET ?? 'p2pwatch';   // per-relay-instance (two relays share one bitcoind)
// PRUNE/TXINDEX-AGNOSTIC tx lookup: node-level getrawtransaction first (mempool always; confirmed
// txs when the node has txindex), then the WATCH WALLET (every tx this relay ever needs touches a
// watched address — HTLC fundings, claims, account moves — so the wallet knows it even on a pruned
// node). Returns the verbose-getrawtransaction shape: { vin, vout, hex, confirmations, … } | null.
async function btcTx(txid) {
  const t = await btcRpc('getrawtransaction', txid, true).catch(() => null);
  if (t) return t;
  const w = await btcWatch('gettransaction', txid, true, true).catch(() => null);
  if (!w?.decoded) return null;
  return { ...w.decoded, hex: w.hex, confirmations: w.confirmations ?? 0, blocktime: w.blocktime, time: w.time };
}
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
      const info = await btcRpcOn('', 'getblockchaininfo').catch(() => null);
      // ~months back — far older than anything this wallet touched; on a PRUNED node never
      // reach below the prune height (rescanblockchain refuses to start in pruned territory)
      const start = Math.max(0, tip - 30000, info?.pruneheight ? info.pruneheight + 1 : 0);
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
// ---- Web Push: "your turn" pings on swap transitions. NO secrets in a push (swap id + status
// only) — the wallet still needs its password-unlocked seed to actually act. A party registers
// the frcPubs it owns (offer-level maker keys / per-swap taker keys); we ping the pub whose
// turn a transition creates. Dead endpoints (404/410) self-unsubscribe; stale ones expire.
const VAPID = loadOrCreateVapid(`${DATADIR}/vapid.json`);
const PUSH_FILE = `${DATADIR}/push-subs.json`;
const pushSubs = new Map();   // frcPub (hex33) → { sub, at }
try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(PUSH_FILE, 'utf8')))) pushSubs.set(k, v); } catch { /* first run */ }
const savePush = () => { try { atomicWrite(PUSH_FILE, JSON.stringify(Object.fromEntries(pushSubs))); } catch {} };
const PUSH_TTL_MS = 7 * 24 * 3600e3;   // a wallet that hasn't refreshed in a week is gone
function notifyPub(pub, payload) {
  const rec = pub && pushSubs.get(pub);
  if (!rec) return;
  if (Date.now() - rec.at > PUSH_TTL_MS) { pushSubs.delete(pub); savePush(); return; }
  sendPush(VAPID, rec.sub, payload)
    .then(r => { if (r.gone) { pushSubs.delete(pub); savePush(); } })
    .catch(() => {});   // push is best-effort: timeouts still protect an unreachable party
}
const pushSwap = (w, side, body) =>
  notifyPub(w?.[side]?.frcPub, { id: w.id, status: w.status, title: `Freimarkets · сделка ${w.id}`, body });

const p2p = [];
const p2pArchive = [];   // COMPLETED swaps, pruned off the live board but kept (cap 100) so clients
                         // can reconstruct their trade history even if their record was lost
let p2pSeq = 1;
// ATOMIC write: fill a temp file, then rename over the target (atomic on the same filesystem). A
// crash / kill / full disk mid-write can no longer leave a truncated JSON that loses the WHOLE
// catalogue on the next load — the target is always a complete previous-or-new version.
function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

const P2P_FILE = `${DATADIR}/market-p2p.json`;
let p2pSaveTimer = null;
function saveP2p() {
  if (p2pSaveTimer) return;
  p2pSaveTimer = setTimeout(() => { p2pSaveTimer = null;
    try { atomicWrite(P2P_FILE, JSON.stringify({ p2pSeq, p2p, archive: p2pArchive.slice(-100) })); } catch {} }, 250);
}
function loadP2p() {
  try { const j = JSON.parse(readFileSync(P2P_FILE, 'utf8'));
    if (Array.isArray(j.p2p)) { p2p.push(...j.p2p); p2pSeq = Number(j.p2pSeq) || p2p.length + 1; }
    if (Array.isArray(j.archive)) p2pArchive.push(...j.archive);
  } catch {}
}
const SWAP_FILE = `${DATADIR}/market-swaps.json`;
let swapSaveTimer = null;
function saveSwaps() {
  if (swapSaveTimer) return;
  swapSaveTimer = setTimeout(() => { swapSaveTimer = null;
    try { atomicWrite(SWAP_FILE, JSON.stringify({ swapSeq, swaps })); } catch {} }, 250);
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
    try { atomicWrite(BOOK_FILE, JSON.stringify({ offerSeq, book })); } catch (e) { say('книга не сохранилась: ' + String(e.message).slice(0, 60)); }
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
let chainId = null;      // genesis hash — clients detect a wiped/replaced chain and drop stale local records
let chainEpoch = null;   // block-1 hash — UNLIKE the genesis hash it DIFFERS after a regtest wipe (fresh
                         // bootstrap wallet ⇒ new coinbase ⇒ new block-1), so clients can distinguish a
                         // reset REGTEST chain (identical deterministic genesis) from a mere relay restart.
async function bootstrap() {
  refreshCookie();
  try { await rpc('createwallet', 'w'); } catch {}
  try { await rpc('loadwallet', 'w'); } catch {}
  chainId = await rpc('getblockhash', 0).catch(() => null);
  mineAddr = await rpc('getnewaddress');
  // MINING/FAUCET are a REGTEST-ONLY dev convenience: on a real chain the relay is a pure
  // indexer + message board (it must never try to produce blocks or hand out coins).
  if (IS_REGTEST && await rpc('getblockcount') < 120) await rpc('generatetoaddress', 120, mineAddr);
  chainEpoch = await rpc('getblockhash', 1).catch(() => chainId);   // after block 1 exists
  loadBook(); loadSwaps(); loadP2p();
  for (const w of p2p) if (w.maker?.frcPub) heartbeat(w.maker.frcPub);   // restart grace for v2 offer expiry
  if (btcAvail()) { await ensureWatchWallet();
    for (const w of p2p) if ((w.status === 'frc_funded' || (w.v === 2 && w.status === 'taken')) && w.btcHtlc?.addr && !w.btcHtlc.txid) await watchAddress(w.btcHtlc.addr).catch(() => {}); }
  await catchUp();
  reconcileBook();   // retire offers whose coins were spent / expired while the relay was down
  say('маркет запущен (релей книги + майнер + автомэтчер)');
  // Tick: on regtest we also MINE (so the dev chain lives); on a real chain we only index+watch.
  setInterval(async () => {
    try {
      if (IS_REGTEST) await rpc('generatetoaddress', 1, mineAddr);
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
  // Self-certifying raw-tx reads: a client fetches the counterparty's HTLC-funding tx and verifies
  // it LOCALLY (recompute txid → parse the output's spk/value/tag) instead of trusting our reported
  // numbers. We can serve a wrong hex, but not one whose txid matches the id the client asked for.
  async rawFrcTx({ txid }) {
    if (!/^[0-9a-f]{64}$/.test(txid || '')) throw new Error('плохой txid');
    const raw = await rpc('getrawtransaction', txid).catch(() => null);
    if (!raw) throw new Error('транзакция не найдена');
    let confs = 0; try { confs = (await rpc('getrawtransaction', txid, true))?.confirmations ?? 0; } catch {}
    return { rawtx: raw, confirmations: confs };
  },
  async rawBtcTx({ txid }) {
    if (!btcAvail()) throw new Error('нет BTC-узла');
    if (!/^[0-9a-f]{64}$/.test(txid || '')) throw new Error('плохой txid');
    const t = await btcTx(txid);
    if (!t) throw new Error('транзакция не найдена');
    return { rawtx: t.hex, confirmations: t.confirmations ?? 0 };
  },
  async info() {
    const h = await rpc('getblockcount');
    return {
      height: h, mineEveryMs: MINE_EVERY_MS, chainId, chainEpoch,
      assets: [...assets.entries()].map(([tag, a]) => ({ tag, ...a, supply: String(a.supply) })),
      // the book exposes EVERYTHING a client needs to splice a cross itself: the give
      // outpoint, the maker's partial witness, terms. The witness is a SINGLE|ACP signature —
      // public by design, it binds only "my coin ↔ this exact output" and does nothing until
      // a crossing counter-offer completes the balance.
      book: book.slice(-80).map(o => {
        const g = utxos.get(o.giveOutpoint);
        const give = g ? { assetTag: g.assetTag, value: String(g.value), refheight: g.refheight, pv: String(pvOf(g, h)), ...(g.tokenHash ? { tokenHash: g.tokenHash, tokens: g.tokens ?? [] } : {}) } : null;
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
      // coinbase flag: without it a client's spendableAt() can't exclude immature block rewards,
      // and pv-descending coin selection ALWAYS picks the freshest coinbase first (least decay)
      out.push({ outpoint: op, spk, assetTag: u.assetTag, value: String(u.value), refheight: u.refheight, pv: String(pvOf(u, h)), ...(u.coinbase ? { coinbase: true } : {}) });
    }
    return { height: h, utxos: out };
  },
  async faucet({ address }) {
    if (!HAS_FAUCET) throw new Error('кран доступен только на тестовой цепи');
    if (!IS_REGTEST) {
      // public chain: rate-limit per address (regtest is private, no need)
      const now = Date.now(), last = faucetLog.get(address) ?? 0;
      if (now - last < 6 * 3600e3) throw new Error('кран: этот адрес уже получал монеты, попробуйте позже');
      if (faucetLog.size > 5000) faucetLog.clear();
      faucetLog.set(address, now);
    }
    const txid = await rpc('sendtoaddress', address, '1.0');
    if (IS_REGTEST) await rpc('generatetoaddress', 1, mineAddr);
    await catchUp();
    say(`кран: 1 FRC → ${address.slice(0, 16)}…`);
    return { txid };
  },
  async issue({ name, shift, interest, amount, spk, decimals, tokens }) {
    // optional smart-property tokens: short utf8 labels minted WITH the asset on the same
    // coin (v2 suffix = tag ++ H(token set); the set itself is revealed in an FRT1 OP_RETURN)
    const toks = Array.isArray(tokens)
      ? [...new Set(tokens.map(s => String(s).trim()).filter(Boolean))].slice(0, 50)
          .map(s => Buffer.from(s, 'utf8').toString('hex'))
      : [];
    if (toks.some(h => h.length / 2 > 64)) throw new Error('токен длиннее 64 байт');
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
    if (IS_REGTEST) await rpc('generatetoaddress', 1, mineAddr);
    const fval = BigInt(Math.round(raw.vout[v].value * 1e8));
    const tx = {
      // issuance = OP_RETURN def + mint (tag rides the spk); no v3 witness-side data ⇒ standard v2.
      // ParseAssetDefinition + conservation are version-independent on the node.
      version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: raw.lockheight, nExpireTime: 0,
      vin: [{ prevout: { txid: rev(ftx), vout: v }, scriptSig: '', sequence: 0xffffffff, witness: TRUE_WITNESS }],
      vout: [
        { value: amt, scriptPubKey: spk, assetTag: tag, ...(toks.length ? { tokens: toks } : {}) },
        { value: 0n, scriptPubKey: '6a' + (4 + def.length).toString(16).padStart(2, '0') + '46524131' + def.toString('hex') },
        // 0-fee on purpose: a token mint's asset output (a few base units) is "dust", and
        // Freicoin policy admits dust outputs only in 0-fee txs. Our node relays 0-fee
        // (minrelaytxfee=0) and our miner includes it (blockmintxfee=0).
        { value: fval, scriptPubKey: TRUE_SPK },
      ],
    };
    // companion 'FRAN' name OP_RETURN (consensus ignores it; indexers read it from-chain). Its
    // sha256 is committed in the def above, so a reader can verify the name against the tag.
    if (toks.length) {   // reveal the minted output's token set (mint needs no input section)
      const reveal = makeTokenReveal(tx.vout, []);
      // opReturnScript emits direct/PUSHDATA1/2 and the light client parses through PUSHDATA4;
      // 65535 is the real ceiling (was a broken `n > 255` guard — ReferenceError on every token issue)
      if (reveal.length / 2 > 65535) throw new Error('токены не влезают в reveal (сократите количество/длину)');
      tx.vout.push({ value: 0n, scriptPubKey: opReturnScript(reveal) });
    }
    const nmeta = Buffer.from(nm, 'utf8');
    tx.vout.push({ value: 0n, scriptPubKey: '6a' + (4 + nmeta.length).toString(16).padStart(2, '0') + '4652414e' + nmeta.toString('hex') });
    await submitTx(serializeTx(tx));
    await catchUp();
    // On regtest the issuance is already mined+indexed here; on a real chain it is still in the
    // mempool, so pre-create the registry entry (the indexer keeps existing entries on catch-up).
    if (!assets.has(tag)) assets.set(tag, { shift, interest, granularity: 1, name: null, supply: 0n, issuedAt: tx.lockHeight });
    Object.assign(assets.get(tag), { name: nm0, decimals: d });
    say(`выпуск: «${nm0}» ×${amount}${d ? ` (.${d})` : ''} (shift ${shift}${interest ? ', растёт' : ''})`);
    return { tag, txid: computeTxid(tx) };
  },
  async tx({ rawtx, kind, offerId }) {
    const parsed = parseTx(rawtx);            // sanity: it parses
    // regtest: mine it straight in (deterministic dev loop, and the nv3 tx version is non-standard
    // for the mempool). A real chain: plain relay — broadcast and let miners confirm it.
    try {
      if (IS_REGTEST) await rpc('generateblock', mineAddr, [rawtx]);
      else await rpc('sendrawtransaction', rawtx);
    } catch (e) {
      // pinpoint a missing/spent input: which prevout does the node's UTXO set lack?
      if (String(e.message).includes('missingorspent')) {
        const miss = [];
        for (const vin of parsed.vin) {
          const op = `${rev(vin.prevout.txid)}:${vin.prevout.vout}`;
          try { const o = await rpc('gettxout', rev(vin.prevout.txid), vin.prevout.vout); if (!o) miss.push(op + ' (spent/unknown)'); }
          catch { miss.push(op + ' (lookup failed)'); }
        }
        say(`tx отклонён: входы отсутствуют → ${miss.join(', ') || '(все входы существуют — проверьте mempool/height)'}`);
        throw new Error(`вход не найден в цепи: ${miss.join(', ') || 'неизвестно'}`);
      }
      throw e;
    }
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
          notifyResign(o);
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
  async rangedOffer({ makerSpk, giveOutpoint, desc, nExpireTime, lockHeight, witness, makerPub }) {
    const g = utxos.get(giveOutpoint);
    if (!g) throw new Error('монета не найдена/уже потрачена');
    if (g.spk !== makerSpk) throw new Error('монета не принадлежит этому ключу');
    if (!desc || desc.payoutScript == null || desc.changeScript == null) throw new Error('плохой дескриптор');
    if (!Array.isArray(witness) || witness.length < 2) throw new Error('нет подписи');
    // optional push target: the maker's compressed pubkey ⇒ we can ping «переподпишите» after
    // a partial fill (the remainder is otherwise silently untradeable while they are offline)
    const pub = typeof makerPub === 'string' && /^0[23][0-9a-f]{64}$/.test(makerPub) ? makerPub : undefined;
    const o = { id: offerSeq++, ranged: true, makerSpk, ...(pub ? { makerPub: pub } : {}), giveOutpoint,
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
  // BTC receive history for the wallet's addresses, derived from the SAME UTXO set the balance
  // uses (listunspent) — so whatever shows in the balance shows in Activity, by construction. One
  // receive entry per funding txid (block time from gettransaction). (Spent receives aren't listed:
  // the funds are gone; and listtransactions on the shared watch wallet mis-attributes swap moves.)
  async btcHistory({ addresses }) {
    if (!btcAvail()) return { txs: [] };
    const addrs = (addresses || []).filter(a => /^(bc|tb|bcrt)1[0-9a-z]{6,90}$/i.test(a)).slice(0, 200);
    if (!addrs.length) return { txs: [] };
    await ensureWatchWallet();
    for (const a of addrs) await watchAddress(a).catch(() => {});
    btcDeepScan(addrs);
    // Full history, not just unspent coins: each touching tx contributes its NET effect on these
    // addresses (outputs to them − inputs from them). A deposit stays visible forever even after
    // its coin is spent; a spend (e.g. locking a swap HTLC from the account) is one 'send' of the
    // true outflow (amount + fee, change already netted out). net==0 (pure pass-through) is noise.
    const set = new Set(addrs);
    const list = await btcWatch('listtransactions', '*', 500, 0, true).catch(() => []);
    const cand = new Set();
    for (const t of list) { if (t.address && set.has(t.address)) cand.add(t.txid); else if (t.category === 'send') cand.add(t.txid); }
    const txs = [];
    for (const txid of cand) {
      const tx = await btcWatch('gettransaction', txid, true, true).catch(() => null);   // (include_watchonly, verbose→.decoded)
      const raw = tx?.decoded; if (!raw) continue;
      let recv = 0, spent = 0; const recvAddrs = [], extAddrs = [];
      for (const o of raw.vout || []) { const a = o.scriptPubKey?.address; if (a) { if (set.has(a)) { recv += o.value; recvAddrs.push(a); } else extAddrs.push(a); } }
      for (const vin of raw.vin || []) {
        const pt = await btcTx(vin.txid);
        const po = pt?.vout?.[vin.vout], a = po?.scriptPubKey?.address;
        if (a && set.has(a)) spent += po.value;
      }
      const net = +(recv - spent).toFixed(8);
      if (!net) continue;
      // ins: the spent txids — lets the client recognize an HTLC-refund receive (it spends a
      // funding txid the client remembers) and label the round-trip instead of a bare "receive".
      // outs: the EXTERNAL (non-mine) output addresses of a send — the HTLC-funding destination so
      // the orphaned-HTLC recovery can spot a paid HTLC whose local swap record was lost.
      txs.push({ txid, category: net > 0 ? 'receive' : 'send', amount: net, confirmations: tx.confirmations ?? 0, time: tx.blocktime ?? tx.time ?? 0, addresses: recvAddrs, outs: extAddrs, ins: (raw.vin || []).map(v => v.txid).filter(Boolean) });
    }
    return { txs };
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
    const braw = await btcTx(btcId);
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
  // the party backing out submits their COOP signature — a one-way "you may take the locked coin
  // back now" authorization. The counterparty completes the instant refund with it (no timelock).
  async p2pCoopSign({ id, sig }) {
    const w = p2p.find(x => x.id === id && x.kind !== 'offer'); if (!w) throw new Error('нет такого свопа');
    if (!/^[0-9a-f]{130,150}$/.test(sig || '')) throw new Error('плохая подпись');
    // only meaningful while a FRC/asset coin is actually locked and the swap isn't settled — this
    // narrows the surface. The FUNDER's client validates the sig cryptographically before using it
    // (a bogus sig is ignored and the timeout refund still runs), so a wrong sig here is inert.
    if (!w.frcHtlc?.txid || ['done', 'cancelled', 'expired'].includes(w.status)) throw new Error('своп не в стадии, где нужна кооп-подпись');
    w.coopSig = sig; saveP2p();
    say(`P2P ${id}: кооп-подпись отмены получена — контрагент вернёт средства мгновенно`);
    return { ok: true };
  },
  // v2 forward BTC coop-cancel: the buyer (taker) paid the BTC HTLC but wants out. The seller
  // (maker) authorizes an instant BTC refund IF they have NOT locked their FRC yet — critically,
  // once the maker locks, the taker (who holds R) could reclaim BTC AND still claim the FRC, so
  // the coop path must be closed then. The relay enforces the gate; the maker's client re-checks.
  async p2pBtcCancelReq({ id, takerFrcPub }) {
    const w = p2p.find(x => x.id === id && x.kind !== 'offer'); if (!w) throw new Error('нет такого свопа');
    if (w.taker?.frcPub !== takerFrcPub) throw new Error('своп не ваш');
    if (w.dir === 'sellBtc') throw new Error('обратный своп: отмена FRC-ноги');
    if (w.frcHtlc?.txid) throw new Error('продавец уже заперся — возврат BTC только по таймауту');
    if (w.frcPending) throw new Error('продавец уже отправил лок — сделка завершится после его подтверждения');
    // a FRESH lock intent = the maker is broadcasting its lock right now — the cancel lost the race.
    // A stale intent (maker died between intent and lock) expires so the buyer isn't blocked forever.
    if (w.lockIntent && Date.now() - w.lockIntent < 10 * 60e3) throw new Error('продавец уже запирает FRC — сделка завершится');
    if (!w.btcHtlc?.txid) throw new Error('оплата ещё не подтверждена');
    w.cancelReq = true; saveP2p();
    pushSwap(w, 'maker', 'Покупатель просит отмену — откройте кошелёк, чтобы подтвердить');
    say(`P2P ${id}: покупатель просит кооп-отмену BTC`);
    return { ok: true };
  },
  async p2pBtcCoopSign({ id, makerFrcPub, sig }) {
    const w = p2p.find(x => x.id === id && x.kind !== 'offer'); if (!w) throw new Error('нет такого свопа');
    if (w.maker?.frcPub !== makerFrcPub) throw new Error('не ваш своп');
    if (w.frcHtlc?.txid || w.frcPending) throw new Error('нельзя: FRC уже заперт');   // safety: R-holder would double-dip (a mempool lock counts too)
    if (!/^[0-9a-f]{130,150}$/.test(sig || '')) throw new Error('плохая подпись');
    w.btcCoopSig = sig; saveP2p();
    pushSwap(w, 'taker', 'Продавец подтвердил отмену — откройте кошелёк, BTC вернутся автоматически');
    say(`P2P ${id}: продавец авторизовал возврат BTC покупателю`);
    return { ok: true };
  },
  // taker reports the coop refund is broadcast → drop the swap (its BTC HTLC coin is now spent)
  async p2pBtcCancelled({ id, takerFrcPub }) {
    const i = p2p.findIndex(x => x.id === id && x.kind !== 'offer'); if (i < 0) return { ok: true };
    const w = p2p[i];
    if (w.taker?.frcPub !== takerFrcPub) throw new Error('своп не ваш');
    if (w.parent) { const o = p2p.find(x => x.id === w.parent && x.kind === 'offer'); if (o) { o.remaining = String(BigInt(o.remaining) + BigInt(w.frcAmount)); if (o.status === 'closed') o.status = 'open'; } }
    p2p.splice(i, 1); saveP2p();
    say(`P2P ${id}: BTC возвращён покупателю (кооп-отмена)`);
    return { ok: true };
  },
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
  // taker backs out of an UNPAID take: release the reservation right away instead of letting it
  // sit until the zombie grace. Allowed only while NOTHING is funded on either side.
  async p2pUntake({ id, takerFrcPub }) {
    const i = p2p.findIndex(x => x.id === id && x.kind !== 'offer'); if (i < 0) throw new Error('нет такого свопа');
    const w = p2p[i];
    if (w.taker?.frcPub !== takerFrcPub) throw new Error('своп не ваш');
    if (w.status !== 'taken' || w.frcHtlc?.txid || w.btcHtlc?.txid) throw new Error('уже есть оплата — отменить нельзя');
    if (w.parent) {
      const o = p2p.find(x => x.id === w.parent && x.kind === 'offer');
      if (o) { const back = w.dir === 'sellBtc' ? w.btcAmount : w.frcAmount; o.remaining = String(BigInt(o.remaining) + BigInt(back)); if (o.status === 'closed') o.status = 'open'; }
      p2p.splice(i, 1);
    } else {   // whole offer: back to the board, clean of this taker's H/terms
      w.status = 'open'; w.taker = null; w.paymentHash = null; w.btcHtlc = null; w.frcHtlc = null; w.takenAt = null;
    }
    saveP2p();
    say(`P2P ${id}: бронь снята покупателем`);
    return { ok: true };
  },
  // maker liveness ping: the drive calls this with the frcPubs of its own open offers.
  async p2pPing({ pubs }) {
    for (const p of (pubs || []).slice(0, 32)) if (/^[0-9a-f]{66}$/.test(p)) heartbeat(p);
    return { ok: true };
  },
  // ---- Web Push subscription plumbing (see the pushSubs block up top) ----
  async pushInfo() { return { key: VAPID.publicKey }; },
  async pushSub({ sub, pubs }) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('плохая подписка');
    if (!/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1024) throw new Error('плохой endpoint');
    if (!Array.isArray(pubs) || pubs.length > 200) throw new Error('плохой список ключей');
    const at = Date.now();
    const clean = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
    let n = 0;
    for (const p of pubs) if (/^[0-9a-f]{66}$/.test(p)) { pushSubs.set(p, { sub: clean, at }); n++; }
    savePush();
    return { ok: true, count: n };
  },
  async pushUnsub({ endpoint }) {
    let n = 0;
    for (const [k, v] of pushSubs) if (v.sub.endpoint === endpoint) { pushSubs.delete(k); n++; }
    savePush();
    return { ok: true, removed: n };
  },
  async p2pList() {
    const fh = await rpc('getblockcount').catch(() => 0);
    const bh = await btcRpc('getblockcount').catch(() => 0);
    const feeRate = btcAvail() ? await btcFeeRate().catch(() => FEE_MIN) : FEE_MIN;
    return { available: btcAvail(), t1: SWAP_T1, t2: SWAP_T2, revTf: REV_TF, revTb: REV_TB, btcNet: BTC_NET, btcHrp: BTC_HRP, frcHeight: fh, btcHeight: bh,
      feeRate,   // sat/vB the client should price its BTC HTLC funding/claim at
      feeMin: feeCache.floor ?? FEE_MIN,   // honest mempool floor (sat/vB) — plain sends (no deadline) may ride it
      minSwap: String(await minSwapSats().catch(() => 546n)),   // smallest sane BTC side (sats) — fills below this are refused
      v2: { btcFar: V2_BTC_FAR, frcNear: V2_FRC_NEAR, frcFar: V2_FRC_FAR, btcNear: V2_BTC_NEAR },
      assetDefs: Object.fromEntries([...assets.entries()].map(([tag, a]) => [tag, { name: a.name, decimals: a.decimals, shift: a.shift }])),
      swaps: p2p.slice(-80).map(w => ({ id: w.id, v: w.v ?? 1, kind: w.kind ?? 'swap', parent: w.parent ?? null, postedAt: w.postedAt ?? null, takenAt: w.takenAt ?? null, partial: !!w.partial, remaining: w.remaining ?? null, minFill: w.minFill ?? null, maxFill: w.maxFill ?? null,
        dir: w.dir ?? 'sellFrc', status: w.status, assetTag: w.assetTag ?? null, frcAmount: w.frcAmount, btcAmount: w.btcAmount,
        maker: w.maker, taker: w.taker, paymentHash: w.paymentHash, t1: w.t1, t2: w.t2,
        frcHtlc: w.frcHtlc, frcPending: w.frcPending ?? null, btcHtlc: w.btcHtlc, preimage: w.preimage ?? null, coopSig: w.coopSig ?? null, cancelReq: !!w.cancelReq, btcCoopSig: w.btcCoopSig ?? null, frcSpendTxid: w.frcSpendTxid ?? null })),
      archive: p2pArchive.slice(-30).map(w => ({ id: w.id, v: w.v ?? 1, parent: w.parent ?? null, postedAt: w.postedAt ?? null, takenAt: w.takenAt ?? null, dir: w.dir ?? 'sellFrc', status: 'done', assetTag: w.assetTag ?? null, frcAmount: w.frcAmount, btcAmount: w.btcAmount,
        maker: w.maker, taker: w.taker, paymentHash: w.paymentHash,
        frcHtlc: w.frcHtlc, btcHtlc: w.btcHtlc, preimage: w.preimage ?? null, archivedAt: w.archivedAt ?? null, frcSpendTxid: w.frcSpendTxid ?? null })) };
  },
  // maker posts an offer at THEIR price. makerBtcAddr = where the maker will receive BTC.
  // assetTag: sell a user-issued asset instead of FRC (CONSTANT assets only — melt/grow value
  // drift between fund and claim is not verified yet). frcAmount then counts asset base units.
  // partial ⇒ an OFFER CONTAINER (sell UP TO frcAmount for a proportional BTC price, in pieces).
  // It holds no single HTLC/secret; each take spawns an independent child sub-swap.
  async p2pPost({ frcAmount, btcAmount, makerFrcPub, makerBtcPub, makerBtcAddr, paymentHash, assetTag, partial, minFill, maxFill }) {
    if (!btcAvail()) throw new Error('своп недоступен: нет BTC-узла');
    if (!/^[0-9a-f]{66}$/.test(makerFrcPub || '') || !/^[0-9a-f]{66}$/.test(makerBtcPub || '')) throw new Error('плохие ключи');
    const tag = assetTag || null;
    if (tag && !assets.get(tag)) throw new Error('неизвестный актив');
    const frc = BigInt(frcAmount), btc = BigInt(btcAmount);
    if (frc <= 0n || btc <= 0n) throw new Error('плохие суммы');
    {   // the WHOLE offer must be worth its on-chain legs too (a partial offer's pieces are checked per take)
      const minBtc = await minSwapSats();
      if (btc < minBtc) throw new Error(`слишком маленькая сделка: BTC-сторона < ${minBtc} сат (комиссия сети съела бы её)`);
      checkMaxSwap(btc);
    }
    const id = 'p2p' + (p2pSeq++);
    // v2 (taker-first): the SECRET lives with the taker now, so the offer commits NO paymentHash —
    // H arrives per take. Maker keys are offer-level (per-child uniqueness comes from the taker's H).
    if (partial) {
      const mn = minFill != null && BigInt(minFill) > 0n ? BigInt(minFill) : 1n;
      const mx = maxFill != null && BigInt(maxFill) > 0n ? BigInt(maxFill) : frc;
      if (mn > mx || mx > frc) throw new Error('неверные мин/макс выкупа');
      const w = { id, v: 2, kind: 'offer', partial: true, status: 'open', dir: 'sellFrc', assetTag: tag, postedAt: indexedHeight,
        frcAmount: String(frc), btcAmount: String(btc), remaining: String(frc), minFill: String(mn), maxFill: String(mx), childSeq: 0,
        maker: { frcPub: makerFrcPub, btcPub: makerBtcPub, btcAddr: makerBtcAddr } };
      p2p.push(w); saveP2p(); heartbeat(makerFrcPub);
      say(`P2P-оффер ${id}: продаю до ${tag ? frc + ' ' + (assets.get(tag)?.name ?? 'актив') : (Number(frc)/1e8) + ' FRC'} за ${Number(btc)/1e8} BTC (частями)`);
      return { id };
    }
    const w = { id, v: 2, status: 'open', dir: 'sellFrc', assetTag: tag, postedAt: indexedHeight, frcAmount: String(frc), btcAmount: String(btc), paymentHash: null,
      maker: { frcPub: makerFrcPub, btcPub: makerBtcPub, btcAddr: makerBtcAddr },
      taker: null, frcHtlc: null, btcHtlc: null, preimage: null, t1: 0, t2: 0 };
    p2p.push(w); saveP2p(); heartbeat(makerFrcPub);
    say(`P2P-оффер ${id}: продаю ${tag ? frc + ' ' + (assets.get(tag)?.name ?? 'актив') : (Number(frc)/1e8) + ' FRC'} за ${Number(btc)/1e8} BTC`);
    return { id };
  },
  // a taker accepts. On a partial offer, `fill` (frc units, default = remaining) spawns a child
  // sub-swap and reserves that much of the remaining; otherwise the whole offer is taken.
  // v2: the taker brings THEIR paymentHash and gets the BTC HTLC address right away — they fund
  // FIRST (far timeout); the maker locks only after that funding confirms. Taking costs commitment.
  async p2pTake({ id, fill, takerFrcPub, takerBtcPub, takerFrcAddr, paymentHash }) {
    const o = p2p.find(x => x.id === id); if (!o) throw new Error('нет такого оффера');
    if (o.v !== 2) throw new Error('оффер устаревшего формата — попросите мейкера перевыставить');
    if (!/^[0-9a-f]{66}$/.test(takerFrcPub || '') || !/^[0-9a-f]{66}$/.test(takerBtcPub || '')) throw new Error('плохие ключи');
    if (!/^[0-9a-f]{64}$/.test(paymentHash || '')) throw new Error('плохой paymentHash');
    const bh = await btcRpc('getblockcount'); const t2 = bh + V2_BTC_FAR;
    const mkBtcHtlc = (w) => {
      const bleaf = btcHtlcLeaf({ paymentHash, claimPub: w.maker.btcPub, refundPub: takerBtcPub, cltv: t2 });
      return { addr: btcHtlcAddress(bleaf, BTC_HRP), leaf: bleaf, cltv: t2, value: w.btcAmount, txid: null, vout: null };
    };
    if (o.kind === 'offer') {
      if (o.status !== 'open') throw new Error('оффер закрыт');
      const rem = BigInt(o.remaining), f = fill != null ? BigInt(fill) : rem;
      if (f <= 0n || f > rem) throw new Error('неверный объём выкупа');
      const mn = o.minFill ? BigInt(o.minFill) : 1n, mx = o.maxFill ? BigInt(o.maxFill) : rem;
      if (f < mn && f < rem) throw new Error('меньше минимального выкупа');   // (allow taking the whole small remainder)
      if (f > mx) throw new Error('больше максимального выкупа');
      const cid = `${id}.${o.childSeq++}`;
      const btc = (BigInt(o.btcAmount) * f + BigInt(o.frcAmount) - 1n) / BigInt(o.frcAmount);   // ceil the proportional price
      // a piece too small to pay its own BTC claim fee + dust would strand the maker's payout
      const minBtc = await minSwapSats();   // must cover its own claim fee with room to spare
      if (btc < minBtc) throw new Error(`слишком маленький кусок: BTC-сторона < ${minBtc} сат (комиссия сети съела бы сделку)`);
      checkMaxSwap(btc);
      const child = { id: cid, v: 2, parent: id, dir: 'sellFrc', assetTag: o.assetTag ?? null,
        frcAmount: String(f), btcAmount: String(btc), paymentHash,
        maker: { ...o.maker }, taker: { frcPub: takerFrcPub, btcPub: takerBtcPub, frcAddr: takerFrcAddr },
        frcHtlc: null, btcHtlc: null, preimage: null, t1: 0, t2, status: 'taken', takenAt: indexedHeight };
      child.btcHtlc = mkBtcHtlc(child);
      o.remaining = String(rem - f); if (BigInt(o.remaining) <= 0n) o.status = 'closed';
      p2p.push(child); saveP2p();
      await watchAddress(child.btcHtlc.addr);   // auto-detect the taker's funding
      say(`P2P ${cid}: частичный выкуп — тейкер финансирует BTC HTLC ${child.btcHtlc.addr}`);
      pushSwap(child, 'maker', 'Оффер взят частично — ждём оплату покупателя');
      return { id: cid, maker: child.maker, assetTag: child.assetTag, frcAmount: child.frcAmount, btcAmount: child.btcAmount, btcHtlc: child.btcHtlc };
    }
    if (o.status !== 'open') throw new Error('оффер уже взят');
    o.taker = { frcPub: takerFrcPub, btcPub: takerBtcPub, frcAddr: takerFrcAddr };
    o.paymentHash = paymentHash;
    o.btcHtlc = mkBtcHtlc(o); o.t2 = t2;
    o.status = 'taken'; o.takenAt = indexedHeight; saveP2p();
    await watchAddress(o.btcHtlc.addr);
    say(`P2P-оффер ${id}: взят — тейкер финансирует BTC HTLC ${o.btcHtlc.addr}`);
    pushSwap(o, 'maker', 'Оффер взят — ждём оплату покупателя');
    return { id, maker: o.maker, assetTag: o.assetTag ?? null, frcAmount: o.frcAmount, btcAmount: o.btcAmount, btcHtlc: o.btcHtlc };
  },
  // maker funded the FRC (or ASSET) HTLC (claim=taker, refund=maker, cltv=T1). Relay VERIFIES on
  // fc-nv3, then hands the taker the BTC HTLC address to fund (claim=maker, refund=taker, T2<T1).
  // For a child sub-swap the maker supplies its per-swap keys + secret hash here (set at fund time).
  // v2: the maker locks the FRC/asset HTLC only AFTER the taker's BTC funding is on-chain
  // (status btc_funded) — with the NEAR timeout. Relay verifies coin, leaf and the timeout window.
  // TWO-PHASE LOCK, phase 1: the maker asks PERMISSION before broadcasting its FRC lock. The check
  // and the marker are set in one synchronous step, so a cancel request and a lock serialize here:
  // whichever touches the relay first wins, and the maker's coins never hit the chain on a swap
  // that is already cancelling (that used to strand both sides into timeout unwinds).
  async p2pFrcIntent({ id, makerFrcPub }) {
    const w = p2p.find(x => x.id === id && x.kind !== 'offer'); if (!w) throw new Error('нет такого свопа');
    if (w.maker?.frcPub !== makerFrcPub) throw new Error('не ваш своп');
    if (w.status !== 'btc_funded') throw new Error('оффер не на этой стадии (сначала BTC тейкера)');
    if (w.btcCoopSig || w.cancelReq) throw new Error('своп отменяется — запирать FRC нельзя');
    w.lockIntent = Date.now(); saveP2p();
    return { ok: true };
  },
  async p2pFrcFunded({ id, txid, vout, t1 }) {
    const w = p2p.find(x => x.id === id && x.kind !== 'offer'); if (!w) throw new Error('нет такого свопа');
    if (w.status !== 'btc_funded') throw new Error('оффер не на этой стадии (сначала BTC тейкера)');
    // ATOMICITY: once this swap is being cooperatively cancelled (buyer requested, or we already
    // authorized the BTC refund), the maker must NEVER lock — else the taker, holding R AND the
    // coop sig, could reclaim BTC and still claim this FRC. A cancel and a lock are mutually exclusive.
    if (w.btcCoopSig || w.cancelReq) throw new Error('своп отменяется — запирать FRC нельзя');
    await catchUp();
    const leaf = htlcLeaf({ paymentHash: w.paymentHash, claimPub: w.taker.frcPub, refundPub: w.maker.frcPub, cltv: Number(t1) });
    const u = utxos.get(`${txid}:${vout}`);
    const wantTag = w.assetTag ?? null;
    // DISTINCT errors: "not indexed yet" (the funding is valid but still in the mempool on a real
    // chain — the client must RETRY, never heal/re-lock) vs a genuine spk/tag "mismatch".
    if (!u) {
      // remember a VERIFIED mempool lock as frcPending: the buyer's UI can then say honestly that
      // the seller has already sent the FRC (and a cancel is refused below) — the swap itself still
      // advances only once the funding is mined and indexed.
      if (!w.frcPending) {
        try {
          const raw = await rpc('getrawtransaction', txid, true);
          const o = raw?.vout?.[Number(vout)];
          const spkHex = o?.scriptPubKey?.hex ?? '';
          const dec = decodeAssetSpk(spkHex);
          const okSpk = (dec ? dec.baseSpk : spkHex) === htlcSpk(leaf) && (dec?.assetTag ?? null) === wantTag;
          if (okSpk && BigInt(Math.round(o.value * 1e8)) >= BigInt(w.frcAmount)) {
            w.frcPending = { txid, vout: Number(vout) }; saveP2p();
            say(`P2P ${id}: лок мейкера уже в мемпуле — ждём блок`);
          }
        } catch { /* tx not even in the mempool — nothing to remember */ }
      }
      throw new Error('HTLC ещё не в блоке — повторите');
    }
    if ((u.assetTag ?? null) !== wantTag || u.spk !== htlcSpk(leaf)) throw new Error('HTLC не совпал');
    if (u.value < BigInt(w.frcAmount)) throw new Error('в HTLC меньше оговоренного');
    const h = await rpc('getblockcount');
    // NEAR window: long enough for the taker to claim, short enough that the maker's own refund
    // (and the taker's R-reveal deadline) lands well before the taker's FAR BTC timeout.
    // tolerance is TIME-based (a lagging client tip / a slow relay tick), not a block count:
    // ±10 min on either side, expressed in this chain's blocks (min 2 blocks so fast chains work)
    if (Number(t1) < h + V2_FRC_NEAR - FRC_SLACK || Number(t1) > h + V2_FRC_NEAR + FRC_SLACK) throw new Error('таймаут T1 вне окна');
    w.frcHtlc = { txid, vout, value: String(u.value), refheight: u.refheight, leaf, cltv: Number(t1), assetTag: wantTag }; w.t1 = Number(t1);
    delete w.frcPending; delete w.lockIntent;   // superseded by the confirmed lock
    w.status = 'frc_funded'; saveP2p();
    say(`P2P ${id}: ${wantTag ? 'актив' : 'FRC'} заперт — тейкер забирает его (раскроет секрет)`);
    pushSwap(w, 'taker', 'Продавец заблокировал FRC — откройте кошелёк, чтобы забрать покупку');
    return { ok: true };
  },
  // taker funded the BTC HTLC from their own wallet — reports the txid; relay verifies on-chain.
  // v2 order: this happens right after take (status 'taken').
  async p2pBtcFunded({ id, btcTxid }) {
    const w = p2p.find(x => x.id === id); if (!w) throw new Error('нет такого оффера');
    if (w.status !== 'taken') throw new Error('оффер не на этой стадии');
    const tx = await btcTx(btcTxid);
    if (!tx) throw new Error('BTC-транзакция не найдена');
    const vout = tx.vout.findIndex(o => o.scriptPubKey.address === w.btcHtlc.addr);
    if (vout < 0) throw new Error('транзакция не платит на HTLC-адрес');
    if (BigInt(Math.round(tx.vout[vout].value * 1e8)) < BigInt(w.btcAmount)) throw new Error('в BTC HTLC меньше оговоренного');
    if ((tx.confirmations ?? 0) < BTC_MINCONF) throw new Error(`ждём подтверждений BTC (${tx.confirmations ?? 0}/${BTC_MINCONF})`);
    w.btcHtlc.txid = btcTxid; w.btcHtlc.vout = vout; w.btcHtlc.value = String(Math.round(tx.vout[vout].value * 1e8));
    w.status = 'btc_funded'; saveP2p();
    say(`P2P ${id}: BTC заперт — мейкер запирает FRC/актив`);
    pushSwap(w, 'maker', 'BTC покупателя подтверждён — откройте кошелёк, чтобы отправить FRC');
    return { ok: true };
  },
  // maker claims the taker's BTC with the now-public R. v2 GUARD: only after the taker already
  // claimed the FRC side (frc_claimed) — the relay never helps a maker take BTC before delivering.
  async p2pBtcClaim({ id, rawtx }) {
    const w = p2p.find(x => x.id === id); if (!w) throw new Error('нет такого оффера');
    if (w.status !== 'frc_claimed') throw new Error('оффер не на этой стадии (актив ещё не забран)');
    const btcId = await btcRpc('sendrawtransaction', rawtx);
    w.btcClaimTxid = btcId; await btcMine(1);
    w.status = 'done'; saveP2p();
    say(`P2P ${id}: мейкер забрал BTC (${btcId.slice(0, 12)}…) — своп завершён`);
    pushSwap(w, 'taker', 'Сделка завершена ✅');
    return { btcClaim: btcId };
  },
  // taker reports they claimed the FRC with R (relay marks the FRC side; the block indexer also
  // detects it independently and extracts R from the claim witness).
  async p2pDone({ id }) {
    const w = p2p.find(x => x.id === id); if (!w) throw new Error('нет такого оффера');
    await catchUp();
    if (!utxos.has(`${w.frcHtlc.txid}:${w.frcHtlc.vout}`) && w.status === 'frc_funded') { w.status = 'frc_claimed'; saveP2p(); pushSwap(w, 'maker', 'Секрет раскрыт — откройте кошелёк, чтобы забрать BTC'); }
    return { status: w.status };
  },

  // ===== REVERSE direction: maker SELLS BTC for FRC. Maker holds R and funds the BTC HTLC FIRST
  // (claim=taker, refund=maker, cltv=TB — the FAR leg); the taker funds the FRC HTLC (claim=maker,
  // refund=taker, cltv=TF — the NEAR leg); the maker claims FRC (reveals R on fc-nv3); the taker
  // claims BTC with R. Timelock ordering (TB later than TF) mirrors the forward path and likewise
  // assumes prompt completion. The relay holds no keys and no funds here either. =====
  // assetTag ⇒ maker buys that CONSTANT asset with BTC (the "FRC leg" the taker funds is an asset
  // HTLC). frcAmount then counts asset base units.
  // partial ⇒ a SELL-BTC offer container (sell UP TO btcAmount in pieces); remaining is in BTC sats.
  async p2pPostB({ frcAmount, btcAmount, makerFrcPub, makerBtcPub, makerFrcAddr, paymentHash, assetTag, partial, minFill, maxFill }) {
    if (!btcAvail()) throw new Error('своп недоступен: нет BTC-узла');
    if (!/^[0-9a-f]{66}$/.test(makerFrcPub || '') || !/^[0-9a-f]{66}$/.test(makerBtcPub || '')) throw new Error('плохие ключи');
    const tag = assetTag || null;
    if (tag && !assets.get(tag)) throw new Error('неизвестный актив');   // any asset type (melt/grow settle via present value)
    const frc = BigInt(frcAmount), btc = BigInt(btcAmount);
    if (frc <= 0n || btc <= 0n) throw new Error('плохие суммы');
    {   // the WHOLE offer must be worth its on-chain legs too (a partial offer's pieces are checked per take)
      const minBtc = await minSwapSats();
      if (btc < minBtc) throw new Error(`слишком маленькая сделка: BTC-сторона < ${minBtc} сат (комиссия сети съела бы её)`);
      checkMaxSwap(btc);
    }
    const id = 'p2p' + (p2pSeq++);
    if (partial) {
      const mn = minFill != null && BigInt(minFill) > 0n ? BigInt(minFill) : 1n;
      const mx = maxFill != null && BigInt(maxFill) > 0n ? BigInt(maxFill) : btc;
      if (mn > mx || mx > btc) throw new Error('неверные мин/макс выкупа');
      const w = { id, kind: 'offer', partial: true, status: 'open', dir: 'sellBtc', assetTag: tag,
        frcAmount: String(frc), btcAmount: String(btc), remaining: String(btc), minFill: String(mn), maxFill: String(mx), childSeq: 0, postedAt: indexedHeight,
        maker: { frcPub: makerFrcPub, btcPub: makerBtcPub, frcAddr: makerFrcAddr } };
      p2p.push(w); saveP2p();
      say(`P2P-оффер ${id}: продаю до ${Number(btc)/1e8} BTC за ${tag ? frc + ' ' + (assets.get(tag)?.name ?? 'актив') : (Number(frc)/1e8)+' FRC'} (частями)`);
      return { id };
    }
    const w = { id, v: 2, dir: 'sellBtc', status: 'open', assetTag: tag, postedAt: indexedHeight, frcAmount: String(frc), btcAmount: String(btc), paymentHash: null,
      maker: { frcPub: makerFrcPub, btcPub: makerBtcPub, frcAddr: makerFrcAddr },
      taker: null, frcHtlc: null, btcHtlc: null, preimage: null, t1: 0, t2: 0 };
    p2p.push(w); saveP2p(); heartbeat(makerFrcPub);
    say(`P2P-оффер ${id}: покупаю ${tag ? frc + ' ' + (assets.get(tag)?.name ?? 'актив') : (Number(frc)/1e8) + ' FRC'} за ${Number(btc)/1e8} BTC`);
    return { id };
  },
  // v2 reverse: the taker (selling FRC/asset for the maker's BTC) brings THEIR H and funds the
  // FRC/asset HTLC FIRST (far timeout); the relay hands back the exact HTLC terms to fund.
  async p2pTakeB({ id, fill, takerFrcPub, takerBtcPub, takerBtcAddr, paymentHash }) {
    const o = p2p.find(x => x.id === id); if (!o || o.dir !== 'sellBtc') throw new Error('нет такого оффера');
    if (o.v !== 2) throw new Error('оффер устаревшего формата — попросите мейкера перевыставить');
    if (!/^[0-9a-f]{66}$/.test(takerFrcPub || '') || !/^[0-9a-f]{66}$/.test(takerBtcPub || '')) throw new Error('плохие ключи');
    if (!/^[0-9a-f]{64}$/.test(paymentHash || '')) throw new Error('плохой paymentHash');
    const fh = await rpc('getblockcount'); const tf = fh + V2_FRC_FAR;
    const mkFrcHtlc = (w) => {
      const fleaf = htlcLeaf({ paymentHash, claimPub: w.maker.frcPub, refundPub: takerFrcPub, cltv: tf });
      return { addr: null, spk: htlcSpk(fleaf), leaf: fleaf, cltv: tf, txid: null, vout: null, value: null, assetTag: w.assetTag ?? null };
    };
    if (o.kind === 'offer') {
      if (o.status !== 'open') throw new Error('оффер закрыт');
      const rem = BigInt(o.remaining), f = fill != null ? BigInt(fill) : rem;   // BTC sats
      if (f <= 0n || f > rem) throw new Error('неверный объём выкупа');
      const mn = o.minFill ? BigInt(o.minFill) : 1n, mx = o.maxFill ? BigInt(o.maxFill) : rem;
      if (f < mn && f < rem) throw new Error('меньше минимального выкупа');
      if (f > mx) throw new Error('больше максимального выкупа');
      const cid = `${id}.${o.childSeq++}`;
      const frcAmt = (BigInt(o.frcAmount) * f + BigInt(o.btcAmount) - 1n) / BigInt(o.btcAmount);   // FRC/asset for this BTC piece (ceil)
      const minBtc = await minSwapSats();
      if (f < minBtc) throw new Error(`слишком маленький кусок: BTC-сторона < ${minBtc} сат (комиссия сети съела бы сделку)`);
      checkMaxSwap(f);
      const child = { id: cid, v: 2, parent: id, dir: 'sellBtc', assetTag: o.assetTag ?? null,
        frcAmount: String(frcAmt), btcAmount: String(f), paymentHash,
        maker: { ...o.maker }, taker: { frcPub: takerFrcPub, btcPub: takerBtcPub, btcAddr: takerBtcAddr },
        frcHtlc: null, btcHtlc: null, preimage: null, t1: tf, t2: 0, status: 'taken', takenAt: indexedHeight };
      child.frcHtlc = mkFrcHtlc(child);
      o.remaining = String(rem - f); if (BigInt(o.remaining) <= 0n) o.status = 'closed';
      p2p.push(child); saveP2p();
      say(`P2P ${cid}: частичная продажа BTC — тейкер финансирует FRC HTLC`);
      pushSwap(child, 'maker', 'Оффер взят частично — покупатель вносит FRC');
      return { id: cid, maker: child.maker, assetTag: child.assetTag, frcAmount: child.frcAmount, btcAmount: child.btcAmount, frcHtlc: { spk: child.frcHtlc.spk, leaf: child.frcHtlc.leaf, cltv: tf } };
    }
    if (o.status !== 'open') throw new Error('оффер уже взят');
    o.taker = { frcPub: takerFrcPub, btcPub: takerBtcPub, btcAddr: takerBtcAddr };
    o.paymentHash = paymentHash;
    o.frcHtlc = mkFrcHtlc(o); o.t1 = tf;
    o.status = 'taken'; o.takenAt = indexedHeight; saveP2p();
    say(`P2P-оффер ${id}: взят (обратный) — тейкер финансирует FRC HTLC`);
    pushSwap(o, 'maker', 'Оффер взят — покупатель вносит FRC');
    return { id, maker: o.maker, assetTag: o.assetTag ?? null, frcAmount: o.frcAmount, btcAmount: o.btcAmount, frcHtlc: { spk: o.frcHtlc.spk, leaf: o.frcHtlc.leaf, cltv: tf } };
  },
  // v2: the maker funds the BTC HTLC (claim=taker, refund=maker, NEAR cltv) only AFTER the taker's
  // FRC/asset is locked (frc_funded_rev). Relay verifies the payment and the timeout window.
  async p2pBtcFundedB({ id, btcTxid, tb }) {
    const w = p2p.find(x => x.id === id && x.kind !== 'offer'); if (!w || w.dir !== 'sellBtc') throw new Error('нет такого свопа');
    if (w.status !== 'frc_funded_rev') throw new Error('оффер не на этой стадии (сначала FRC тейкера)');
    const bh = await btcRpc('getblockcount');
    if (Number(tb) < bh + V2_BTC_NEAR - BTC_SLACK || Number(tb) > bh + V2_BTC_NEAR + BTC_SLACK) throw new Error('таймаут BTC вне окна');
    const bleaf = btcHtlcLeaf({ paymentHash: w.paymentHash, claimPub: w.taker.btcPub, refundPub: w.maker.btcPub, cltv: Number(tb) });
    const baddr = btcHtlcAddress(bleaf, BTC_HRP);
    const tx = await btcTx(btcTxid);
    if (!tx) throw new Error('BTC-транзакция не найдена');
    const vout = tx.vout.findIndex(o => o.scriptPubKey.address === baddr);
    if (vout < 0) throw new Error('транзакция не платит на HTLC-адрес');
    if (BigInt(Math.round(tx.vout[vout].value * 1e8)) < BigInt(w.btcAmount)) throw new Error('в BTC HTLC меньше оговоренного');
    // btc_funded_rev triggers the taker's R-revealing claim — the maker's funding must be un-RBF-able first
    if ((tx.confirmations ?? 0) < BTC_MINCONF) throw new Error(`ждём подтверждений BTC (${tx.confirmations ?? 0}/${BTC_MINCONF})`);
    w.btcHtlc = { addr: baddr, leaf: bleaf, cltv: Number(tb), value: String(Math.round(tx.vout[vout].value * 1e8)), txid: btcTxid, vout }; w.t2 = Number(tb);
    w.status = 'btc_funded_rev'; saveP2p();
    say(`P2P ${id}: BTC заперт мейкером — тейкер забирает BTC (раскроет секрет)`);
    pushSwap(w, 'taker', 'Продавец отправил BTC — откройте кошелёк, чтобы забрать');
    return { ok: true };
  },
  // v2: taker funded the FRC/asset HTLC right after take. Relay verifies on fc-nv3.
  async p2pFrcFundedB({ id, txid, vout }) {
    const w = p2p.find(x => x.id === id); if (!w || w.dir !== 'sellBtc') throw new Error('нет такого оффера');
    if (w.status !== 'taken') throw new Error('оффер не на этой стадии');
    await catchUp();
    const u = utxos.get(`${txid}:${vout}`);
    const wantTag = w.assetTag ?? null;
    if (!u || (u.assetTag ?? null) !== wantTag || u.spk !== w.frcHtlc.spk) throw new Error('HTLC не найден/не совпал');
    if (u.value < BigInt(w.frcAmount)) throw new Error('в HTLC меньше оговоренного');
    w.frcHtlc.txid = txid; w.frcHtlc.vout = vout; w.frcHtlc.value = String(u.value); w.frcHtlc.refheight = u.refheight;
    w.status = 'frc_funded_rev'; saveP2p();
    say(`P2P ${id}: FRC/актив заперт тейкером — мейкер запирает BTC`);
    pushSwap(w, 'maker', 'Покупатель внёс FRC — откройте кошелёк, чтобы отправить BTC');
    return { ok: true };
  },
  // v2: taker claims the maker's BTC with R (reveals it). Relay broadcasts and surfaces R so the
  // maker can claim the FRC/asset side.
  async p2pBtcClaimB({ id, rawtx }) {
    const w = p2p.find(x => x.id === id); if (!w || w.dir !== 'sellBtc') throw new Error('нет такого оффера');
    if (w.status !== 'btc_funded_rev') throw new Error('оффер не на этой стадии');
    const btcId = await btcRpc('sendrawtransaction', rawtx);
    w.btcClaimTxid = btcId; await btcMine(1);
    const R = await preimageFromTx(btcId, w.paymentHash);
    if (R) { w.preimage = R; w.status = 'btc_claimed_rev'; saveP2p(); }
    say(`P2P ${id}: тейкер забрал BTC (${btcId.slice(0, 12)}…) — секрет раскрыт, мейкер забирает FRC/актив`);
    pushSwap(w, 'maker', 'Секрет раскрыт — откройте кошелёк, чтобы забрать FRC');
    return { btcClaim: btcId, preimage: w.preimage };
  },
  // maker built their FRC claim (reveals R on fc-nv3). Relay broadcasts + mines; surfaces R.
  async p2pFrcClaimB({ id, rawtx }) {
    const w = p2p.find(x => x.id === id); if (!w || w.dir !== 'sellBtc') throw new Error('нет такого оффера');
    if (w.v === 2) throw new Error('v2: мейкер забирает FRC обычной транзакцией после раскрытия секрета');
    if (w.status !== 'frc_funded_rev') throw new Error('оффер не на этой стадии');
    await submitTx(rawtx); await catchUp();
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

// ---- rate limiting: a token bucket per client IP ----
// The relay is a public endpoint whose handlers hit two full nodes. Two budgets: a generous one for
// the polling reads every open tab does, and a tight one for WRITES (posting/taking offers), which
// is where a spammer could flood the board or burn node RPC. Behind nginx the real IP is in XFF.
const RL_READ = Number(process.env.RL_READ ?? 240);    // requests/min/IP
const RL_WRITE = Number(process.env.RL_WRITE ?? 20);   // mutating calls/min/IP
const MAX_BODY = Number(process.env.MAX_BODY ?? (4 << 20));   // 4 MiB request-body cap
// Safety net: a stray rejection is logged and ignored (it can't corrupt in-memory state); a truly
// uncaught exception leaves the process in an undefined state, so log it and exit cleanly — systemd
// restarts and bootstrap() reloads the persisted book/swaps. A single bad request must never do this.
process.on('unhandledRejection', e => console.error('[relay] unhandledRejection:', e?.message ?? e));
process.on('uncaughtException', e => { console.error('[relay] uncaughtException:', e?.stack ?? e); process.exit(1); });
// Clean restart (systemd sends SIGTERM): flush the debounced snapshots NOW so the last <250 ms of
// mutations aren't lost between the timer and exit. Writes are atomic, so this is always safe.
function flushPersist() {
  for (const t of [saveTimer, swapSaveTimer, p2pSaveTimer]) if (t) clearTimeout(t);
  saveTimer = swapSaveTimer = p2pSaveTimer = null;
  try { atomicWrite(BOOK_FILE, JSON.stringify({ offerSeq, book })); } catch {}
  try { atomicWrite(SWAP_FILE, JSON.stringify({ swapSeq, swaps })); } catch {}
  try { atomicWrite(P2P_FILE, JSON.stringify({ p2pSeq, p2p, archive: p2pArchive.slice(-100) })); } catch {}
  try { savePush(); } catch {}
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushPersist(); process.exit(0); });
const WRITE_CALLS = new Set(['p2pPost', 'p2pPostB', 'p2pTake', 'p2pTakeB', 'p2pUntake', 'p2pCancel',
  'p2pFrcFunded', 'p2pFrcFundedB', 'p2pBtcFunded', 'p2pBtcFundedB', 'p2pBtcClaim', 'p2pBtcClaimB',
  'p2pFrcClaimB', 'p2pFrcIntent', 'p2pDone', 'p2pDoneB', 'p2pCoopSign', 'tx', 'btcBroadcast', 'issue', 'faucet',
  'offer', 'cancel', 'resignRanged', 'pushSub', 'pushUnsub']);
const buckets = new Map();   // ip → { read: {n, at}, write: {n, at} }
setInterval(() => { const now = Date.now(); for (const [ip, b] of buckets) if (now - Math.max(b.read.at, b.write.at) > 300e3) buckets.delete(ip); }, 60e3).unref?.();
function rateOk(ip, kind, limit) {
  const now = Date.now();
  const b = buckets.get(ip) ?? { read: { n: 0, at: now }, write: { n: 0, at: now } };
  const c = b[kind];
  if (now - c.at >= 60e3) { c.n = 0; c.at = now; }   // fresh window
  c.n++;
  buckets.set(ip, b);
  return c.n <= limit;
}

const server = createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Content-Type': 'application/json; charset=utf-8' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    const m = /^\/api\/(\w+)$/.exec(req.url ?? '');
    if (!m || !(m[1] in api)) { res.writeHead(404, cors); return res.end('{"error":"not found"}'); }
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    const write = WRITE_CALLS.has(m[1]);
    if (!rateOk(ip, write ? 'write' : 'read', write ? RL_WRITE : RL_READ)) {
      res.writeHead(429, cors); return res.end('{"error":"слишком много запросов — попробуйте через минуту"}');
    }
    let body = {};
    if (req.method === 'POST') body = await new Promise((ok, bad) => {
      // JSON.parse used to run inside this 'end' callback UNGUARDED — a malformed body threw into the
      // event loop (outside the handler's try), crashing the whole relay. Guard it (→ 400) and cap the
      // body so a huge/never-ending upload can't exhaust memory.
      let d = '', n = 0;
      req.on('data', c => { n += c.length; if (n > MAX_BODY) { bad(new Error('body too large')); req.destroy(); } else d += c; });
      req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { bad(new Error('malformed JSON body')); } });
      req.on('error', () => bad(new Error('request stream error')));
    });
    const out = await api[m[1]](body);
    res.writeHead(200, cors);
    res.end(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? String(v) : v));
  } catch (e) { res.writeHead(400, cors); res.end(JSON.stringify({ error: e.message })); }
});
await bootstrap();
server.listen(LISTEN, '0.0.0.0', () => console.log(`market server on :${LISTEN}, chain ${DATADIR}, indexed to ${indexedHeight}`));
