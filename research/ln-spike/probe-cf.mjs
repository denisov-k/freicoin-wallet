import { encodeMessage, createDecoder, buildVersion, buildGetCFilters, parseCFilter } from '../../apps/web/src/services/light/net/p2p.mjs';
import { execFileSync } from 'node:child_process';
const btcli=(...a)=>execFileSync('/root/bitcoin-core/bin/bitcoin-cli',['-regtest','-datadir=/root/btc-regtest','-rpcport=18443',...a],{encoding:'utf8'}).trim();
const H=+btcli('getblockcount'), hash=btcli('getblockhash', String(H-2));
const net='btcregtest', dec=createDecoder(net);
const ws=new WebSocket('ws://127.0.0.1:3071'); ws.binaryType='arraybuffer';
let ready=false;
ws.onopen=()=>ws.send(encodeMessage(net,'version',buildVersion({ua:'/p/'})));
ws.onmessage=e=>{ for(const m of dec(Buffer.from(e.data))){
  if(m.command==='version') ws.send(encodeMessage(net,'verack'));
  if(m.command==='verack'&&!ready){ ready=true; console.log('sending getcfilters for height', H-2); ws.send(encodeMessage(net,'getcfilters',buildGetCFilters(H-2, hash))); }
  if(m.command==='cfilter'){ const cf=parseCFilter(m.payload); console.log('GOT cfilter, bytes', cf.filter.length); process.exit(0); }
}};
setTimeout(()=>{console.log('NO cfilter reply (peerblockfilters issue?)'); process.exit(0);},6000);
