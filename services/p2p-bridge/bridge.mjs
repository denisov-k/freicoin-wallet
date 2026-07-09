// bridge.mjs — WebSocket ↔ TCP relay so a browser can speak the Freicoin P2P
// protocol (browsers can't open raw TCP). It only forwards bytes; the client
// verifies everything cryptographically, so the relay can censor/observe but not
// forge data. It connects only to the configured node (not an open relay).
import net from 'net';
import { WebSocketServer } from 'ws';

const NODE_HOST = process.env.FW_NODE_HOST || '127.0.0.1';
const NODE_PORT = parseInt(process.env.FW_NODE_PORT || '19555', 10);
const PORT = parseInt(process.env.FW_BRIDGE_PORT || '3040', 10);

const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });
wss.on('connection', ws => {
  const tcp = net.connect(NODE_PORT, NODE_HOST);
  tcp.on('data', d => ws.readyState === ws.OPEN && ws.send(d));
  ws.on('message', d => tcp.write(Buffer.from(d)));
  const close = () => { try { tcp.destroy(); } catch {} try { ws.close(); } catch {} };
  tcp.on('close', close); tcp.on('error', close); ws.on('close', close); ws.on('error', close);
});
console.log(`p2p-bridge ws://0.0.0.0:${PORT} → freicoin ${NODE_HOST}:${NODE_PORT}`);
