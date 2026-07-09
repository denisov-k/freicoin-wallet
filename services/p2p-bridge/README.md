# p2p-bridge

A WebSocket↔TCP relay so the browser wallet can speak the Freicoin P2P protocol
(browsers can't open raw TCP). It **only forwards bytes** between a browser
WebSocket and a configured Freicoin node's P2P port — the light client verifies
every header, filter and Merkle proof itself, so the relay can censor or observe
traffic but cannot forge data. It connects only to the configured node, not to
arbitrary hosts.

```sh
FW_NODE_HOST=127.0.0.1 FW_NODE_PORT=8333 FW_BRIDGE_PORT=3040 node bridge.mjs
```

WebSocket permessage-deflate is enabled (level 1) — it shaves ~15% off the
header/proof stream for bandwidth-bound clients; browsers negotiate it
automatically. A fully zero-infra client would need Freicoin nodes to expose a
WebSocket P2P endpoint natively.
