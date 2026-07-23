// market-bot — a liquidity maker for the P2P exchange: posts a partial sell-FRC offer priced
// from FreiExchange (+spread) and performs ALL maker duties by reusing the wallet's own battle-
// tested swap engine (services/market/swap-drive.mjs) headless under Node.
//
// Architecture: the browser wallet's market modules only touch the DOM through two injected
// callbacks (initDrive) and persistence through localStorage — so a file-backed localStorage
// shim + a `location` stub make the WHOLE maker path (verify HTLC → lock FRC → claim BTC →
// refund on stall → heartbeat) run server-side with zero logic duplication.
//
// The bot has its OWN seed (services/market-bot is a separate wallet on purpose):
//   • a browser session with the same seed would be a second driver of the same swaps — the
//     two could double-fund a lock; separate keys make that impossible;
//   • a server compromise leaks only the bot's trading float, not the owner's main wallet.
// Fund it by sending mature FRC to the address it prints on boot; sweep proceeds by importing
// the seed (BOT_DIR/seed.txt) into the wallet as a hex seed.
//
// Env: BOT_DIR (/root/fw-bot) — seed + state; RELAY (default http://127.0.0.1:5183/api);
//      FRC_DATADIR (/root/fw-mainnet-filter) + FRC_RPCPORT (18951) — local node, scantxoutset;
//      BOT_SPREAD (0.25 = ask 25% over the reference price), BOT_MIN_FRC (min offer, FRC),
//      BOT_MAX_FRC (cap per offer), BOT_REPRICE (0.10 — repost when price drifts 10%),
//      BOT_DRY=1 — full engine, but strategy only logs (no posting).
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ---- browser shims (MUST install before the app modules load) ----
const DIR = process.env.BOT_DIR || '/root/fw-bot';
mkdirSync(DIR, { recursive: true });
const LSF = DIR + '/localstorage.json';
let lsdb = {}; try { lsdb = JSON.parse(readFileSync(LSF, 'utf8')); } catch {}
const lsave = () => { try { writeFileSync(LSF, JSON.stringify(lsdb, null, 1)); } catch {} };
globalThis.localStorage = {
  getItem: k => (k in lsdb ? lsdb[k] : null),
  setItem: (k, v) => { lsdb[k] = String(v); lsave(); },
  removeItem: k => { delete lsdb[k]; lsave(); },
};
globalThis.location = /** @type {any} */ ({ protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1' });

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- app modules (dynamic: after the shims) ----
const { configureNetwork } = await import('@/services/wallet.mjs');
configureNetwork('main');
const { ctx, api, p2pKey, setRelayOverride } = await import('@/state/market-ctx.mjs');
if (process.env.RELAY) setRelayOverride('main', process.env.RELAY.replace(/\/+$/, ''));
const { derivePath, ckdPriv, wpkProgramHex } = await import('@core/hd.mjs');
const { pubkeyCompressed } = await import('@core/ecdsa.mjs');
const { sha256, hash160 } = await import('@core/crypto.mjs');
const { btcAddress } = await import('@core/btc.mjs');
const { freeFrcKria } = await import('@/services/market/swap-lib.mjs');
const { loadP2p, putP2p, dropP2p, addBtcNonce } = await import('@/services/storage.mjs');
const { driveP2p, checkP2pRefunds, checkBtcRefunds, initDrive } = await import('@/services/market/swap-drive.mjs');
const { refreshBtc, btcAcctAddr, mvBtc, initBtcAccount } = await import('@/services/market/btc-account.mjs');

// ---- bot wallet: own seed, the wallet's EXACT derivation. The coin type follows the network
// (mainnet = m/84'/0'/0'); hardcoding coin 1 (nv3) here made the bot ADVERTISE the coin-0 address
// (deriveAddress) but SCAN coin-1 scripts — so it never saw its own mining or received coins. ----
const { currentNet } = await import('@/services/wallet.mjs');
const { NETWORKS } = await import('@/state/network-params.mjs');
const ACCOUNT = `m/84'/${NETWORKS[currentNet()].coinType}'/0'`;
const SEEDF = DIR + '/seed.txt';
if (!existsSync(SEEDF)) { writeFileSync(SEEDF, randomBytes(32).toString('hex') + '\n'); chmodSync(SEEDF, 0o600); log('generated a NEW bot seed at', SEEDF); }
const seed = readFileSync(SEEDF, 'utf8').trim();
ctx.seed = seed;
{
  const acct = derivePath(seed, ACCOUNT);
  const km = {}, spks = [];
  for (const chain of [0, 1]) {
    const c = ckdPriv(acct, chain);
    for (let i = 0; i < 12; i++) { const node = ckdPriv(c, i); const spk = '0014' + wpkProgramHex(node); km[spk] = node; spks.push(spk); }
  }
  ctx.spks = spks; ctx.km = km;
}
const { deriveAddress } = await import('@/services/wallet.mjs');
log('bot FRC address:', deriveAddress(seed, 0, 0));

const { browserSwapEnv } = await import('@/services/market/swap-env.mjs');
initDrive(browserSwapEnv({ toast: (m, kind) => log(`[${kind || 'info'}]`, m), mvRefresh: () => { wantRefresh = true; }, observe: () => {} }));
initBtcAccount(() => {});   // no browser-side nonce recovery needed: the bot's records never leave BOT_DIR

// ---- local FRC node (trusted — it's ours): height + UTXOs via scantxoutset ----
const FRC_DATADIR = process.env.FRC_DATADIR || '/root/fw-mainnet-filter';
const FRC_RPC = `http://127.0.0.1:${process.env.FRC_RPCPORT || 18951}/`;
const cookie = () => readFileSync(FRC_DATADIR + '/.cookie', 'utf8').trim();
async function rpc(method, ...params) {
  const r = await fetch(FRC_RPC, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(cookie()).toString('base64') },
    body: JSON.stringify({ method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || String(j.error));
  return j.result;
}
async function refreshState() {
  // Coins from the relay's INDEXED utxo endpoint (instant, complete, NOMINAL values — the same view
  // the wallet uses), not a per-minute `scantxoutset` full-chain scan (heavy, and it returned
  // present-valued amounts + could stall on a "concurrent scan", leaving the bot stuck on a stale,
  // under-counted balance). Height stays from the node — authoritative for HTLC timelocks.
  const [info, swap, p2p, height, ux] = await Promise.all([
    api('info').catch(() => ({ assets: [], book: [], events: [], height: 0 })),
    api('swapInfo').catch(() => null),
    api('p2pList').catch(() => null),
    rpc('getblockcount'),
    api('utxos', { spks: ctx.spks }).catch(() => ({ utxos: [] })),
  ]);
  const utxos = (ux.utxos || []).map(u => ({
    outpoint: u.outpoint, spk: u.spk, value: String(u.value), refheight: u.refheight,
    assetTag: u.assetTag ?? null, coinbase: !!u.coinbase,
  }));
  ctx.state = { info, defs: {}, mine: { height, utxos }, swap, p2p };
}

// ---- pricing: FreiExchange FRC_BTC ticker; the ask sits SPREAD above the reference ----
const SPREAD = Number(process.env.BOT_SPREAD ?? 0.25);
const REPRICE = Number(process.env.BOT_REPRICE ?? 0.10);
const MIN_FRC = Number(process.env.BOT_MIN_FRC ?? 300);      // don't post below this (fee floor territory)
const MAX_FRC = Number(process.env.BOT_MAX_FRC ?? 40000);    // per-offer cap (also respects relay BTC_MAX_SWAP)
const FEE_RESERVE = 200000n;                                 // kria kept back for HTLC-funding fees
const DRY = !!process.env.BOT_DRY;
let lastPrice = null;   // sat per FRC (float)
async function fetchPrice() {
  const j = await fetch('https://api.freiexchange.com/public/ticker/FRC', { signal: AbortSignal.timeout(15000) }).then(r => r.json());
  const t = j?.FRC_BTC?.[0]; if (!t) throw new Error('ticker: no FRC_BTC');
  // reference = the best real bid/last trade; lowestSell alone can be a fantasy ask
  const ref = Math.max(Number(t.last) || 0, Number(t.highestBuy) || 0) * 1e8;
  if (!(ref > 0)) throw new Error('ticker: zero price');
  return ref;   // sat per FRC
}

// my open offer records (both partial and whole-only maker offers this bot posted)
const myOffers = () => loadP2p().filter(r => r.role === 'maker' && !r.parent && r.status === 'open');
const myAsks = () => myOffers().filter(r => r.dir !== 'sellBtc');   // sell FRC for BTC
const myBids = () => myOffers().filter(r => r.dir === 'sellBtc');   // BUY FRC (sell BTC)

// Min-fill policy: the maker pays a FIXED ~170 vB BTC claim fee on EVERY fill, so a fill at the
// bare network floor nets the bot ~half the offer price — value burned to miners, not traded.
// Keep the per-fill overhead ≤ BOT_FILL_OVERHEAD (15%): minFill_btc = claimFee / overhead. The 5%-
// of-lot component (the DEX anti-griefing default) stops big lots from being shaved into hundreds
// of micro-fills; the relay's own floor stays as the absolute lower bound. All three float with
// live BTC fees / lot size, so the policy self-adjusts when conditions change.
const FILL_OVERHEAD = Number(process.env.BOT_FILL_OVERHEAD ?? 0.15);
// ---- BID side (buy FRC with the account's BTC): the other half of the market. The bid sits
// SPREAD_BID below the reference; the whole float (minus a fee reserve) is offered, capped by the
// relay's own BTC_MAX_SWAP training-wheels limit. With an empty BTC account the side just idles.
const SPREAD_BID = Number(process.env.BOT_SPREAD_BID ?? process.env.BOT_SPREAD ?? 0.10);
const MIN_BID = BigInt(Math.round(Number(process.env.BOT_MIN_BID_SATS ?? 3000)));     // don't bid below this (sats)
const MAX_BID = BigInt(Math.round(Number(process.env.BOT_MAX_BID_SATS ?? 200000)));   // relay hard-caps swaps at 200k sat
const BTC_RESERVE = BigInt(Math.round(Number(process.env.BOT_BTC_RESERVE ?? 2000)));  // sats kept for HTLC-funding fees
async function postOffer(frcK, satPerFrc) {
  const btcSats = BigInt(Math.ceil(Number(frcK) / 1e8 * satPerFrc));
  const nonce = sha256(Buffer.from(seed + 'fw-p2p-nonce:' + frcK + ':' + btcSats + ':' + ctx.state.mine.height, 'utf8')).toString('hex').slice(0, 16);
  const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
  const myBtcAddr = btcAddress(hash160(Buffer.from(btcPub, 'hex')).toString('hex'), ctx.state.swap?.btcHrp || 'bc');
  const minSwap = BigInt(Math.round(Number(ctx.state.p2p?.minSwap ?? 741)));            // relay network floor (sats)
  const claimFee = BigInt(Math.ceil(Math.max(1, Number(ctx.state.p2p?.feeRate ?? 2)) * 170));   // my per-fill BTC claim cost
  const overheadFloor = BigInt(Math.ceil(Number(claimFee) / FILL_OVERHEAD));             // keep claim fee ≤ 15% of a fill
  const minBtc = [minSwap, overheadFloor, btcSats / 20n].reduce((a, b) => a > b ? a : b); // + 5% of the lot
  let minFill = (minBtc * frcK + btcSats - 1n) / btcSats;
  // WHOLE-ONLY when the min piece is the entire offer: a small lot whose min fill (fee-overhead
  // floor) meets or exceeds the whole amount can only sell as one piece. Clamp minFill to the lot
  // and post non-partial — else the relay rejects mn > mx ("неверные мин/макс выкупа").
  const partial = minFill < frcK;
  if (!partial) minFill = frcK;
  const r = await api('p2pPost', { frcAmount: String(frcK), btcAmount: String(btcSats), makerFrcPub: frcPub, makerBtcPub: btcPub,
    makerBtcAddr: myBtcAddr, ...(partial ? { partial: true, minFill: String(minFill), maxFill: String(frcK) } : {}) });
  addBtcNonce(nonce);
  putP2p({ id: r.id, role: 'maker', nonce, status: 'open', partial, assetTag: null, frcAmount: String(frcK), btcAmount: String(btcSats) });
  log(`posted ${r.id}: sell ${Number(frcK) / 1e8} FRC @ ${satPerFrc.toFixed(2)} sat/FRC (total ${btcSats} sat, ${partial ? 'minFill ' + Number(minFill) / 1e8 + ' FRC' : 'whole-only'})`);
}
async function cancelOffer(rec) {
  try { await api('p2pCancel', { id: rec.id, makerFrcPub: pubkeyCompressed(p2pKey(rec.nonce, 'frc')) }); } catch (e) { log('cancel', rec.id, e.message); }
  // If takes of this offer are still in flight on the relay, the record must SURVIVE the cancel:
  // driveP2p adopts a committed take by copying the offer-level nonce from the parent record —
  // dropping it here left a paying taker facing a seller that could never lock (p2p13.4).
  // 'cancelled' keeps it out of myOffers() so the strategy reposts; driveP2p GCs it once the
  // last take settles.
  const inFlight = (ctx.state.p2p?.swaps || []).some(s => s.parent === rec.id);
  if (inFlight) { putP2p({ ...rec, status: 'cancelled' }); log(`cancel ${rec.id}: kept (takes in flight)`); }
  else dropP2p(rec.id);
}

async function postBid(btcSats, satPerFrc) {
  const frcK = BigInt(Math.round(Number(btcSats) / satPerFrc * 1e8));
  const nonce = sha256(Buffer.from(seed + 'fw-p2p-nonce:B:' + frcK + ':' + btcSats + ':' + ctx.state.mine.height, 'utf8')).toString('hex').slice(0, 16);
  const frcPub = pubkeyCompressed(p2pKey(nonce, 'frc')), btcPub = pubkeyCompressed(p2pKey(nonce, 'btc'));
  // min fill mirrors the ask side: my per-fill cost here is FUNDING the BTC HTLC (~200 vB)
  const minSwap = BigInt(Math.round(Number(ctx.state.p2p?.minSwap ?? 741)));
  const fundFee = BigInt(Math.ceil(Math.max(1, Number(ctx.state.p2p?.feeRate ?? 2)) * 200));
  const overheadFloor = BigInt(Math.ceil(Number(fundFee) / FILL_OVERHEAD));
  let minFill = [minSwap, overheadFloor, btcSats / 20n].reduce((a, b) => a > b ? a : b);
  const partial = minFill < btcSats;
  if (!partial) minFill = btcSats;
  const r = await api('p2pPostB', { frcAmount: String(frcK), btcAmount: String(btcSats), makerFrcPub: frcPub, makerBtcPub: btcPub,
    makerFrcAddr: deriveAddress(seed, 0, 0), ...(partial ? { partial: true, minFill: String(minFill), maxFill: String(btcSats) } : {}) });
  addBtcNonce(nonce);
  putP2p({ id: r.id, role: 'maker', dir: 'sellBtc', nonce, status: 'open', partial, assetTag: null, frcAmount: String(frcK), btcAmount: String(btcSats) });
  log(`posted ${r.id}: BUY ${Number(frcK) / 1e8} FRC @ ${satPerFrc.toFixed(2)} sat/FRC (pay ${btcSats} sat, ${partial ? 'minFill ' + minFill + ' sat' : 'whole-only'})`);
}

// buy side: quote a bid from the account's BTC float. Same trigger bands as the ask
// (drift >10%, grown 3/2, shrunk 2/3, dust) over amounts measured in SATS.
async function manageBid(price, live) {
  const b = mvBtc();
  if (b.balance == null) return;
  const bidRate = price * (1 - SPREAD_BID);
  let free = BigInt(b.balance) - BTC_RESERVE; if (free < 0n) free = 0n;
  const target = free > MAX_BID ? MAX_BID : free;
  const mine = myBids().filter(r => live.some(x => x.id === r.id && x.status === 'open' && (x.kind === 'offer' || x.dir === 'sellBtc')));
  if (!mine.length) {
    if (target < MIN_BID) return;   // empty/small float — the side idles silently
    if (DRY) { log(`DRY: would bid ${target} sat @ ${bidRate.toFixed(2)} sat/FRC`); return; }
    return postBid(target, bidRate);
  }
  const rec = mine[0], x = live.find(o => o.id === rec.id);
  const offerRate = Number(BigInt(x.btcAmount)) / Number(BigInt(x.frcAmount)) * 1e8;
  const drift = Math.abs(offerRate - bidRate) / bidRate;
  const remaining = BigInt(x.remaining ?? x.btcAmount);   // reverse offers track remaining in SATS
  const grown = target > (remaining * 3n) / 2n && target - remaining >= MIN_BID;
  const shrunk = target < (remaining * 2n) / 3n && remaining - target >= MIN_BID;
  const minPiece = x.minFill ? BigInt(x.minFill) : MIN_BID;
  const dustRemainder = remaining < BigInt(x.btcAmount) && remaining < minPiece;
  if (drift > REPRICE || dustRemainder || grown || shrunk) {
    log(`repost bid ${rec.id}: drift ${(drift * 100).toFixed(1)}%, remaining ${remaining} sat, target ${target} sat${shrunk ? ' (shrink)' : ''}`);
    if (DRY) return;
    await cancelOffer(rec);
    if (target >= MIN_BID) await postBid(target, bidRate);
  }
}

async function strategy() {
  // the relay was unreachable this tick (restart/reindex): an empty p2p view is MISSING DATA, not an
  // empty board — GC'ing records against it dropped a live offer AND its funded child (p2p14/14.1),
  // then re-posted a duplicate offer from scratch.
  if (!ctx.state.p2p?.swaps) return;
  const price = await fetchPrice().catch(e => { log('price feed:', e.message); return lastPrice; });
  if (!price) return;   // no reference at all — don't quote blind
  lastPrice = price;
  const ask = price * (1 + SPREAD);
  const free = freeFrcKria() - FEE_RESERVE;
  const capK = BigInt(Math.round(MAX_FRC * 1e8));
  const live = ctx.state.p2p?.swaps || [];
  // recognize BOTH kinds still on the board: a partial offer is kind:'offer'; a whole-only offer is
  // a plain sellFrc swap at status 'open'. Missing the whole-only case made the bot repost every tick.
  const mine = myAsks().filter(r => live.some(s => s.id === r.id && s.status === 'open' && (s.kind === 'offer' || s.dir === 'sellFrc')));
  for (const r of myOffers()) if (!mine.includes(r) && !live.some(s => s.id === r.id)) dropP2p(r.id);   // gone from the relay ⇒ settled/expired
  // one live offer at a time: size = all free mature FRC (capped)
  const target = free > capK ? capK : free;
  const floorK = BigInt(Math.round(MIN_FRC * 1e8));
  if (!mine.length) {
    if (target < floorK) log(`idle: free ${Number(free > 0n ? free : 0n) / 1e8} FRC < min ${MIN_FRC}`);
    else if (DRY) log(`DRY: would post sell ${Number(target) / 1e8} FRC @ ${ask.toFixed(2)} sat/FRC`);
    else await postOffer(target, ask);
    return manageBid(price, live);
  }
  // reprice/resize: relay board is authoritative for remaining
  const rec = mine[0], s = live.find(x => x.id === rec.id);
  const offerRate = Number(BigInt(s.btcAmount)) / Number(BigInt(s.frcAmount)) * 1e8;   // sat per FRC
  const drift = Math.abs(offerRate - ask) / ask;
  const remaining = BigInt(s.remaining ?? s.frcAmount);
  const grown = target > (remaining * 3n) / 2n && target - remaining >= floorK;   // mined coins matured — restock
  // "almost sold out" ONLY applies to an offer that was actually PARTIALLY filled and now has a
  // remainder too small to fill one more min-piece. On a FRESH offer remaining == frcAmount and can
  // always fill (minFill ≤ frcAmount by construction) — comparing to minPieceK*2 there misfired and
  // reposted every tick whenever minFill was a large fraction of the lot (infinite loop).
  const dustRemainder = remaining < BigInt(s.frcAmount) && remaining < minPieceK(s);
  // SHRINK: the advertised remainder must never sit far above what the bot can actually lock — an
  // oversized offer (posted from an inflated pre-coinbase-fix balance, or after coins moved into
  // locks) stalls any take larger than the real free float. 2/3 vs the grown trigger's 3/2 keeps
  // the two bands from oscillating.
  const shrunk = target < (remaining * 2n) / 3n && remaining - target >= floorK;
  // LND came up after this offer was posted: repost so it advertises the ⚡ leg (ln flag is set at post time)
  if (drift > REPRICE || dustRemainder || grown || shrunk) {
    log(`repost ${rec.id}: drift ${(drift * 100).toFixed(1)}%, remaining ${Number(remaining) / 1e8} FRC, target ${Number(target) / 1e8}${shrunk ? ' (shrink)' : ''}`);
    if (!DRY) {
      await cancelOffer(rec);
      if (target >= floorK) await postOffer(target, ask);
    }
  }
  return manageBid(price, live);
}
// the offer's own advertised min piece (kria) — falls back to mapping the relay floor through the price
const minPieceK = s => s.minFill ? BigInt(s.minFill)
  : (BigInt(Math.round(Number(ctx.state.p2p?.minSwap ?? 741))) * BigInt(s.frcAmount) + BigInt(s.btcAmount) - 1n) / BigInt(s.btcAmount);

// ---- main loop ----
let wantRefresh = false, tick = 0;
log(`market-bot up — relay ${process.env.RELAY || 'default :5183'}, spread ${SPREAD * 100}%, dry=${DRY}`);
for (;;) {
  try {
    await refreshState();
    await driveP2p();          // maker duties: verify+lock FRC, claim BTC, heartbeat, coop-cancel
    await checkP2pRefunds();   // sweep my stalled FRC locks home after T1
    await checkBtcRefunds();   // (no-op for a pure maker, harmless)
    if (tick % 5 === 0) {      // strategy on every 5th tick (~5 min)
      await strategy();
      await refreshBtc().catch(() => {});
      const b = mvBtc();
      log(`state: free ${Number(freeFrcKria() > 0n ? freeFrcKria() : 0n) / 1e8} FRC, BTC acct ${b.balance != null ? Number(b.balance) / 1e8 : '?'} (${btcAcctAddr()}), offers ${myOffers().length}, records ${loadP2p().length}`);
    }
  } catch (e) { log('loop error:', e.message); }
  tick++;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && !wantRefresh) await new Promise(r => setTimeout(r, 1000));
  wantRefresh = false;
}
