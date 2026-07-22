import { encodeMessage, createDecoder, buildVersion, buildGetHeaders, parseHeaders } from '../../apps/web/src/services/light/net/p2p.mjs';
import { execFileSync } from 'node:child_process';
const btcli=(...a)=>execFileSync('/root/bitcoin-core/bin/bitcoin-cli',['-regtest','-datadir=/root/btc-regtest','-rpcport=18443',...a],{encoding:'utf8'}).trim();
const tipHash=btcli('getbestblockhash');
const net='btcregtest', dec=createDecoder(net);
const ws=new WebSocket('ws://127.0.0.1:3071'); ws.binaryType='arraybuffer';
let ready=false;
ws.onopen=()=>ws.send(encodeMessage(net,'version',buildVersion({ua:'/p/'})));
ws.onmessage=e=>{ for(const m of dec(Buffer.from(e.data))){
  if(m.command==='version') ws.send(encodeMessage(net,'verack'));
  if(m.command==='verack'&&!ready){ ready=true; console.log('sending getheaders at tip'); ws.send(encodeMessage(net,'getheaders',buildGetHeaders(70016,tipHash))); }
  if(m.command==='headers'){ console.log('GOT headers, count=', parseHeaders(m.payload).length); process.exit(0); }
}};
setTimeout(()=>{console.log('NO headers reply at tip (Core silent) — confirmed'); process.exit(0);},6000);
