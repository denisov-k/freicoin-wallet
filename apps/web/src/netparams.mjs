// netparams.mjs — per-network constants. The wallet targets one network at a time;
// switching networks resets the light-client state (different genesis + address HRP).
// genesis hashes are from Freicoin's kernel/chainparams.cpp; coinType is SLIP44
// (0 = mainnet, 1 = all test networks); hrp is the bech32m human-readable prefix.
export const NETWORKS = {
  main:    { label: 'Mainnet', hrp: 'fc',   coinType: 0, genesis: '000000005b1e3d23ecfd2dd4a6e1a35238aa0392c0a8528c40df52376d7efe2c' },
  test:    { label: 'Testnet', hrp: 'tf',   coinType: 1, genesis: '000000003b5183593282fd30d3d7e79243eb883d6c2d8670f69811c6b9a76585' },
  regtest: { label: 'Regtest', hrp: 'fcrt', coinType: 1, genesis: '67756db06265141574ff8e7c3f97ebd57c443791e0ca27ee8b03758d6056edb8' },
};

export const DEFAULT_NET = 'regtest';

// Default bridge (WS↔TCP relay) per network — overridable in Settings / via VITE_BRIDGE.
// Static header-snapshot per network (verified client-side — the channel needs no trust);
// null = bootstrap from P2P only.
export const DEFAULT_SNAPSHOT = {
  main:    import.meta.env?.VITE_SNAP_MAIN || null,
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
};
