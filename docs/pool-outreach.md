# Merged-mining outreach — small / solo pools

**Goal:** get non-institutional SHA-256 pools to merge-mine Freicoin. Freicoin shares Bitcoin's
double-SHA-256 PoW (AuxPoW, `DEPLOYMENT_AUXPOW` active), and `freicoind` ships a **built-in stratum
server** that speaks the standard `mining.aux.subscribe` extension — the same one a pool's
merge-mine proxy already uses for Namecoin / Rootstock / Syscoin. So for a pool that already
merge-mines *anything*, adding Freicoin is a config line, not an engineering project.

**The pitch (one sentence):** "Point your existing SHA-256 hashrate at our aux-stratum endpoint and
your miners earn Freicoin block subsidies alongside Bitcoin — zero extra energy, zero extra hardware,
you keep the reward addresses."

**Why small/solo first:** F2Pool said "not yet" (2026-07-15 — wants volume/exchange/team visibility).
The big-4 (Foundry, AntPool, ViaBTC, F2Pool) hold >70% of hashrate and are institutional. Small and
solo operators are ideological, reachable directly, and several already market merge-mining as a
feature — for them we're additive, not a favor.

---

## Tier 1 — already merge-mine SHA-256 coins (warmest: integration already exists)

### solopool.org  ★ top target
- Non-custodial solo infra ("no pool wallet, no balances"). Already runs SHA-256 pools (BTC, BCH,
  DigiByte, Fractal Bitcoin) **and markets merged mining** (added Litecoin+Dogecoin merge-mining
  Jan 2026). Compatible with NiceHash / MiningRigRentals.
- **Fit:** merge-mining is literally their product line; a SHA-256 aux coin is their existing flow.
- **Contact:** Telegram https://t.me/solopool_org · Twitter https://twitter.com/solopool_org
- **Angle:** "You already merge-mine LTC/DOGE for your miners — Freicoin is a SHA-256 aux coin, so it
  drops into the same non-custodial flow. Here's a `freicoind` aux-stratum endpoint to test against."

### Kryptex Pool
- Multi-coin pool with **automatic merge-mining** ("connect with your wallet address, collect from
  multiple networks, no extra config"). Has a public merge-mining program/article.
- **Fit:** they onboard merge-mined coins as a standing feature; there's a process to slot into.
- **Contact:** via pool.kryptex.com merge-mining program / support.
- **Angle:** submit Freicoin as a new aux coin for their auto-merge roster.

### mmpool (merge-mining pool, historical)
- Long-running merge-mining pool (BTC + NMC/Syscoin/Devcoin/…). May be dormant — **verify it's live**
  before spending effort. If live, it's the canonical "add another aux coin" shop.

---

## Tier 2 — solo / home-miner pools (ideological, self-hostable, huge reach via Bitaxe)

### public-pool.io  ★ strategic target (open source)
- The community-standard **open-source** solo pool for the Bitaxe / NerdMiner home-mining boom;
  self-hostable, no account, 20+ coins.
- **Why it's special:** it's open source — we are **not dependent on the operator**. Two paths:
  (a) contribute a Freicoin integration PR upstream, or (b) self-host a Freicoin-enabled instance
  and point the home-miner crowd at it. Either way it reaches thousands of hobbyist solo miners who
  would merge-mine an interesting coin for free "lottery tickets."
- **Contact:** GitHub (public-pool repo) — issue + PR.
- **Angle:** "Freicoin is SHA-256 AuxPoW with a built-in aux-stratum; here's a PR/instance so your
  Bitaxe miners get Freicoin lottery blocks alongside BTC at no cost."

### solo.ckpool.org (Con Kolivas)
- The battle-tested solo proxy (2% fee, many solo block finds). **Lower priority:** Kolivas runs a
  deliberately minimal Bitcoin-only shop; unlikely to add an altcoin. Listed for completeness.

### NodeRunners · AtlasPool
- Smaller SOLO pools in the same home-miner niche. Approach after public-pool/solopool land — a
  reference integration makes the ask trivial ("X already does it").

---

## Sequence

1. **solopool.org** (Telegram) — warmest, merge-mining is their product. Fastest possible yes.
2. **public-pool.io** (GitHub PR/self-host) — highest leverage; open source means we can just *do* it.
3. **Kryptex** — standing merge-mining program, submit Freicoin.
4. Verify **mmpool** is live; if so, add.
5. NodeRunners / AtlasPool once there's a reference integration to point at.

## What we hand a pool (integration kit — to prepare)
- A public `freicoind` **aux-stratum endpoint** (mainnet, once IBD done) they can test against.
- One-page integration note: enable `-stratum`, send `mining.aux.subscribe`, embed the returned aux
  commitment — mirrors their existing Namecoin/RSK merge-mine proxy.
- Reward-address handling (they keep their own payout addresses; non-custodial).

## Prerequisite
Mainnet must be live (IBD finishing ~2026-07-18) so we can expose a real aux-stratum endpoint —
nobody merge-mines a chain they can't point a proxy at. Public signet (freicoin.ru/signet) is the
proof-of-concept to show in the first message.

---
*Sources:* solopool.org · pool.kryptex.com/articles/merge-mine · public-pool.io (GitHub) ·
solo.ckpool.org · bitcointalk "[auxPOW] Which pools offer Merge Mining?" (topic 1876020) ·
Rootstock merged-mining Q1 2026 report. Compiled 2026-07-17.
