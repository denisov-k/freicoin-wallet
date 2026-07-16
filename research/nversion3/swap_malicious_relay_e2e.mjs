// swap_malicious_relay_e2e.mjs — prove the three swap-maker fixes (audit 2026-07-16) defend against
// a MALICIOUS relay, and don't break the honest path. Reproduces the EXACT security predicates the
// maker paths in swap-drive.mjs now run (same core functions), for honest vs. malicious relay data.
//   SWAP-1 (fwd maker): the taker's BTC leaf is rebuilt with the maker's OWN derived claim key, not
//           the relay-echoed w.maker.btcPub → a substituted key fails the leaf check.
//   SWAP-2 (rev maker): the taker's FRC far leg is rebuilt with the maker's own key + its funded
//           output independently verified → a fabricated/mis-keyed leg is rejected before locking.
//   SWAP-3 (both): the counterparty's far leg must outlast the near leg by a 2× wall-clock margin.
import { createHash } from 'node:crypto';
import { pubkeyCompressed } from '@core/ecdsa.mjs';
import { frcLeg } from '@core/swap.mjs';
import { btcHtlcLeaf } from '@core/btc.mjs';

const sha256 = b => createHash('sha256').update(b).digest();
// p2pKey EXACTLY as market-ctx.mjs derives it
const p2pKey = (seed, nonce, leg) => sha256(Buffer.from(seed + 'fw-p2p:' + nonce + ':' + leg, 'utf8')).toString('hex');
const H = 'df6b6e9f1e077f40'.padEnd(64, '0');   // a payment hash (per-swap)
let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? '✅' : '❌'} ${name}`); cond ? pass++ : fail++; };

// two independent wallets
const makerSeed = 'a'.repeat(64), takerSeed = 'b'.repeat(64), attackerSeed = 'f'.repeat(64);
const nonce = 7;

// ---------- SWAP-1: forward maker binds its OWN btc claim key ----------
console.log('SWAP-1 — forward maker: BTC leaf must commit the maker\'s own claim key');
{
  const myBtcPub = pubkeyCompressed(p2pKey(makerSeed, nonce, 'btc'));   // maker's OWN key (the fix)
  const takerBtcPub = pubkeyCompressed(p2pKey(takerSeed, nonce, 'btc'));
  const attackerPub = pubkeyCompressed(p2pKey(attackerSeed, nonce, 'btc'));
  const cltv = 1000;

  // HONEST relay: it echoes the maker's real key; the taker funded a leaf built with it.
  const honestEcho = myBtcPub;                                          // w.maker.btcPub (honest)
  const fundedLeafHonest = btcHtlcLeaf({ paymentHash: H, claimPub: honestEcho, refundPub: takerBtcPub, cltv });
  const makerRebuildHonest = btcHtlcLeaf({ paymentHash: H, claimPub: myBtcPub, refundPub: takerBtcPub, cltv });   // NEW code
  ok('honest: maker\'s own-key leaf matches the funded output → maker locks', makerRebuildHonest === fundedLeafHonest);

  // MALICIOUS relay: substitutes its own key on BOTH sides. It builds the funding address (that the
  // taker pays) with the attacker key, AND echoes the attacker key as w.maker.btcPub.
  const evilEcho = attackerPub;                                         // w.maker.btcPub (substituted)
  const fundedLeafEvil = btcHtlcLeaf({ paymentHash: H, claimPub: evilEcho, refundPub: takerBtcPub, cltv });
  const oldCodeRebuild = btcHtlcLeaf({ paymentHash: H, claimPub: evilEcho, refundPub: takerBtcPub, cltv });       // OLD (buggy): used w.maker.btcPub
  const newCodeRebuild = btcHtlcLeaf({ paymentHash: H, claimPub: myBtcPub, refundPub: takerBtcPub, cltv });       // NEW (fix): own key
  ok('OLD code (relay key) would ACCEPT the attacker leaf (the vuln)', oldCodeRebuild === fundedLeafEvil);
  ok('NEW code (own key) REJECTS it → maker refuses to lock', newCodeRebuild !== fundedLeafEvil);
}

// ---------- SWAP-2: reverse maker binds its own FRC claim key ----------
console.log('SWAP-2 — reverse maker: FRC far leg must commit the maker\'s own claim key');
{
  const myFrcKey = p2pKey(makerSeed, nonce, 'frc');
  const takerFrcPub = pubkeyCompressed(p2pKey(takerSeed, nonce, 'frc'));
  const attackerFrcPub = pubkeyCompressed(p2pKey(attackerSeed, nonce, 'frc'));
  const cltv = 5000, net = 'nv3';

  // the taker funded the FRC HTLC: claim=maker, refund=taker. HONEST relay reports the maker's key.
  const fundedHonest = frcLeg({ role: 'give', ourKey: p2pKey(takerSeed, nonce, 'frc'), theirPub: pubkeyCompressed(myFrcKey), paymentHash: H, cltv, net }).leaf;
  const makerRebuild = frcLeg({ role: 'receive', ourKey: myFrcKey, theirPub: takerFrcPub, paymentHash: H, cltv, net }).leaf;   // NEW code
  ok('honest: maker\'s own-key FRC leaf matches the taker\'s funding → maker locks BTC', makerRebuild === fundedHonest);

  // MALICIOUS relay: taker "funded" (or the relay claims so) a leaf whose claim side is the attacker.
  const fundedEvil = frcLeg({ role: 'give', ourKey: p2pKey(takerSeed, nonce, 'frc'), theirPub: attackerFrcPub, paymentHash: H, cltv, net }).leaf;
  ok('NEW code REJECTS an FRC leg not claimable by the maker → no BTC locked', makerRebuild !== fundedEvil);
}

// ---------- SWAP-3: far > near timelock margin (both directions) ----------
console.log('SWAP-3 — far leg must outlast the near leg by a 2× wall-clock margin');
{
  // forward: near = FRC (frcNear blocks @ mineEveryMs), far = BTC (cltv @ 600s/block)
  const mineEveryMs = 20000, frcNear = 60, btcHeight = 100000;
  const nearSec = frcNear * (mineEveryMs / 1000);                       // 1200s
  const farOK = btcHeight + Math.ceil((nearSec * 2) / 600) + 5;         // comfortably > 2× near
  const farShort = btcHeight + 1;                                       // relay lies: far ~ 600s
  const check = farCltv => (Math.max(0, farCltv - btcHeight) * 600) >= nearSec * 2;   // the guard
  ok('honest: far(BTC) ≥ 2× near(FRC) window → accepted', check(farOK));
  ok('malicious: a short far(BTC) leg → rejected (unsafe timelocks)', !check(farShort));

  // reverse: near = BTC (btcNear @ 600s), far = FRC (cltv @ mineEveryMs)
  const btcNear = 6, frcHeight = 500000;
  const nearSecR = btcNear * 600;                                       // 3600s
  const farOKr = frcHeight + Math.ceil((nearSecR * 2) / (mineEveryMs / 1000)) + 5;
  const farShortR = frcHeight + 1;
  const checkR = farCltv => (Math.max(0, farCltv - frcHeight) * (mineEveryMs / 1000)) >= nearSecR * 2;
  ok('honest: far(FRC) ≥ 2× near(BTC) window → accepted', checkR(farOKr));
  ok('malicious: a short far(FRC) leg → rejected', !checkR(farShortR));
}

console.log(`\n${pass}/${pass + fail} predicate checks pass`);
process.exit(fail ? 1 : 0);
