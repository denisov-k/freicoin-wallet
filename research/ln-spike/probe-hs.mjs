import { encodeMessage, createDecoder, buildVersion } from '../../apps/web/src/services/light/net/p2p.mjs';
const net='btcregtest';
const dec=createDecoder(net);
const ws=new WebSocket('ws://127.0.0.1:3071'); ws.binaryType='arraybuffer';
ws.onopen=()=>{ console.log('open; sending version'); ws.send(encodeMessage(net,'version',buildVersion({ua:'/probe/'}))); };
ws.onmessage=e=>{ for(const m of dec(Buffer.from(e.data))) { console.log('RECV', m.command, 'ok='+m.ok, 'len='+m.payload.length); if(m.command==='version') ws.send(encodeMessage(net,'verack')); } };
ws.onerror=()=>console.log('ws error');
ws.onclose=e=>{ console.log('ws closed', e.code); process.exit(0); };
setTimeout(()=>{console.log('timeout'); process.exit(0);},8000);
