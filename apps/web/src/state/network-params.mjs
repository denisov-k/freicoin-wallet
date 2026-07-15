// netparams.mjs — per-network constants. The wallet targets one network at a time;
// switching networks resets the light-client state (different genesis + address HRP).
// genesis hashes are from Freicoin's kernel/chainparams.cpp; coinType is SLIP44
// (0 = mainnet, 1 = all test networks); hrp is the bech32m human-readable prefix.
// `nv3: true` marks a chain that runs the nVersion=3-lite consensus (assets + DEX). ONLY there may
// a transaction carry NV3_TX_VERSION — every other network rejects it as non-standard/invalid, so
// swap transactions must fall back to plain version 2 (host FRC has no assetTag to serialize).
export const NETWORKS = {
  main:    { label: 'Mainnet', hrp: 'fc',   coinType: 0, genesis: '000000005b1e3d23ecfd2dd4a6e1a35238aa0392c0a8528c40df52376d7efe2c' },
  // REHEARSAL net for the BTC↔FRC swap: a private chain on regtest params dressed in a fully
  // production relay config (no faucet/miner-tick, sendrawtransaction-only, windowed indexing,
  // BTC_MINCONF=1) with strict 10-min timer blocks. Public testnet was rejected: dead since
  // 2025-03 and rebase-31 aborts in its headers presync (missing m_headers_sync_params); signet
  // can't carry witness txs (no FINALTX ⇒ no witness-commitment slot). Same genesis as nv3 but a
  // separate net key keeps light-client state and swap records apart. Live since 2026-07-14.
  test:    { label: 'Testnet', hrp: 'fcrt', coinType: 1, genesis: '67756db06265141574ff8e7c3f97ebd57c443791e0ca27ee8b03758d6056edb8' },
  // hidden: superseded by Freimarkets (same regtest genesis + fcrt addresses, plus assets/DEX);
  // the node and /ws/regtest bridge stay up for development.
  regtest: { label: 'Regtest', hrp: 'fcrt', coinType: 1, genesis: '67756db06265141574ff8e7c3f97ebd57c443791e0ca27ee8b03758d6056edb8', hidden: true },
  // Freimarkets: the experimental nVersion=3 chain that backs market.testtty.ru. Regtest
  // genesis + fcrt addresses, so the same key resolves to the same coins the market shows;
  // a distinct net key keeps its light-client state separate from the plain regtest demo.
  nv3:     { label: 'Freimarkets', hrp: 'fcrt', coinType: 1, genesis: '67756db06265141574ff8e7c3f97ebd57c443791e0ca27ee8b03758d6056edb8', nv3: true },
};

export const DEFAULT_NET = 'main';

// Default bridge (WS↔TCP relay) per network — overridable in Settings / via VITE_BRIDGE.
// Static header-snapshot per network (verified client-side — the channel needs no trust);
// null = bootstrap from P2P only.
export const DEFAULT_SNAPSHOT = {
  main:    import.meta.env?.VITE_SNAP_MAIN || null,
  test:    null,
  regtest: null,
};
// Build-time checkpoint 'height:hash' — fast first syncs anchor here instead of genesis.
// For a web-delivered wallet this adds no trust: the same host already serves the code.
const parseCp = v => { const m = /^(\d+):([0-9a-f]{64})$/.exec(v || ''); return m ? { height: +m[1], hash: m[2] } : null; };
export const CHECKPOINT = {
  main:    parseCp(import.meta.env?.VITE_CHECKPOINT_MAIN),
  test:    null,
  regtest: null,
};

export const DEFAULT_SNAPSHOT_FILTERS = {
  main:    import.meta.env?.VITE_SNAP_MAIN_FILTERS || null,
  test:    null,
  regtest: null,
};

export const DEFAULT_BRIDGE = {
  main:    import.meta.env?.VITE_BRIDGE_MAIN || 'ws://127.0.0.1:3041',
  test:    import.meta.env?.VITE_BRIDGE_TEST || 'ws://127.0.0.1:3042',
  regtest: import.meta.env?.VITE_BRIDGE || 'ws://127.0.0.1:3040',
  nv3:     import.meta.env?.VITE_BRIDGE_NV3 || 'ws://127.0.0.1:3055',
};
