// step9: ПРОДУКТОВЫЕ файлы фазы 2 end-to-end — apps/web/src/services/light/ln/{ln-node,relay-feed,
// ldk-chain,ws-net}.mjs против стенда: LND-алиса (LSP) + regtest bitcoind + фид-стаб с прод-
// контрактом + живой VSS-релей :5182. Плюс НОВОЕ против step8: канал открывает НАШ узел
// (openChannel → fundingReady → funding-tx строится «кошельком» → LDK бродкастит).
// Запуск: node --import ../../apps/web/test/register-aliases.mjs step9-product.mjs init|resume
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import * as ldk from '../../apps/web/node_modules/lightningdevkit/index.mjs';   // ТА ЖЕ копия, что у продуктовых модулей (две wasm-инстанции = беда)
import { LnNode } from '../../apps/web/src/services/light/ln/ln-node.mjs';
import { RelayChainFeed } from '../../apps/web/src/services/light/ln/relay-feed.mjs';
import { VssClient } from '../../apps/web/src/services/light/net/vss-client.mjs';

const MODE = process.argv[2];
if (!['init', 'resume'].includes(MODE)) { console.error('usage: init|resume'); process.exit(1); }
const BENCH = '/tmp/claude-0/-root-free-money/e555c6c3-1be8-497c-bfab-7ed5f9628ddf/scratchpad/lnbench';
const DIR = BENCH + '/step9'; mkdirSync(DIR, { recursive: true });
const BTCLI = ['/root/bitcoin-core/bin/bitcoin-cli', '-regtest', '-datadir=/root/btc-regtest', '-rpcport=18443'];
const LNCLI_A = ['lncli', `--lnddir=${BENCH}/alice`, '--network=regtest', '--rpcserver=127.0.0.1:10011'];
const btcli = (...a) => execFileSync(BTCLI[0], [...BTCLI.slice(1), ...a], { encoding: 'utf8', maxBuffer: 64e6 }).trim();
const alice = (...a) => new Promise((res, rej) => execFile(LNCLI_A[0], [...LNCLI_A.slice(1), ...a], { encoding: 'utf8' }, (e, out, err) => e ? rej(new Error((err || String(e)).slice(0, 160))) : res(JSON.parse(out))));
const feedApi = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:3079/api/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j;
};

await ldk.initializeWasmFromBinary(readFileSync('../../apps/web/node_modules/lightningdevkit/liblightningjs.wasm'));

const seedFile = DIR + '/seed'; if (!existsSync(seedFile)) writeFileSync(seedFile, randomBytes(32));
const seed = new Uint8Array(readFileSync(seedFile));
const km = ldk.KeysManager.constructor_new(seed, 1n, 0, false);
const nodeId = Buffer.from(km.as_NodeSigner().get_node_id(ldk.Recipient.LDKRecipient_Node).res).toString('hex');
const hwStore = { get: k => existsSync(`${DIR}/hw_${k}`) ? +readFileSync(`${DIR}/hw_${k}`, 'utf8') : null,
                  set: (k, v) => writeFileSync(`${DIR}/hw_${k}`, String(v)) };
const vss = new VssClient({ apiBase: 'http://127.0.0.1:5182/api', nodeId, seedBytes: seed, hwStore });

// прогресс фида персистится как в воркере: последняя обработанная высота
const hFile = DIR + '/feed-height';
const anchorHeight = +btcli('getblockcount'), anchorHash = btcli('getbestblockhash');
const fromHeight = existsSync(hFile) ? +readFileSync(hFile, 'utf8') + 1 : null;
const node = new LnNode({
  seedBytes: seed, net: 'btcregtest', vss,
  makeFeed: adapter => new RelayChainFeed({ api: feedApi, adapter, fromHeight, onHeight: h => writeFileSync(hFile, String(h)), log: (...a) => console.log('  [feed]', ...a) }),
  anchor: { hash: anchorHash, height: anchorHeight },
  broadcast: hex => { try { btcli('sendrawtransaction', hex); console.log('  [bcast]', hex.length / 2, 'bytes'); } catch (e) { console.log('  [bcast ERR]', String(e).slice(0, 100)); } },
  log: (...a) => console.log(' ', ...a),
});

const R = randomBytes(32), H = createHash('sha256').update(R).digest('hex');
let claimed = false, ready = false, funding = null;
node.on.channelReady = () => { ready = true; node.flushManager().catch(() => {}); };
node.on.paymentClaimable = hash => { if (hash === H) { console.log('  held → claim_funds(R)'); node.claimFunds(R.toString('hex')); } };
node.on.paymentClaimed = h => { if (h === H) claimed = true; };   // реплей из VSS-стейта не считается
node.on.fundingReady = (tmpId, spkHex, sats) => { funding = { spkHex, sats }; };

await node.start();
console.log(`started (${MODE}); channels: ${node.chanMgr.list_channels().length}`);

const ALICE_PK = (await alice('getinfo')).identity_pubkey;
for (let i = 0; i < 60; i++) {
  node.peerMgr.process_events();
  if ((await alice('listpeers')).peers?.some(p => p.pub_key === node.nodeId)) break;
  if (i % 10 === 0) { try { await node.connectPeer('ws://127.0.0.1:3070', ALICE_PK); } catch {} }
  await new Promise(r => setTimeout(r, 200));
}
const mine = async n => { btcli('generatetoaddress', String(n), (await alice('newaddress', 'p2wkh')).address); };

if (MODE === 'init') {
  // НАШ узел открывает канал: funding-tx строит «кошелёк» (здесь — bitcoind-кошелёк стенда)
  console.log('-- opening OUR 400k channel to alice…');
  try { btcli('createwallet', 'step9fund'); } catch {}
  const fundAddr = btcli('-rpcwallet=step9fund', 'getnewaddress', '', 'bech32');
  btcli('generatetoaddress', '110', fundAddr);   // созревшие монеты для funding-tx
  // LND отвергает open_channel, пока догоняет цепь («Synchronizing blockchain») — дождаться
  for (let i = 0; i < 100; i++) { if ((await alice('getinfo')).synced_to_chain) break; await new Promise(r => setTimeout(r, 300)); }
  node.openChannel(ALICE_PK, 400000);
  for (let i = 0; i < 100 && !funding; i++) { await node.tick(); await new Promise(r => setTimeout(r, 100)); }
  if (!funding) { console.error('no FundingGenerationReady'); process.exit(1); }
  // адрес из funding-скрипта (P2WSH) — платим на него кошельковой транзакцией, но НЕ бродкастим:
  // подписанный hex отдаём LDK, бродкаст делает канал (иначе алиса не увидит наш funding_signed)
  const addr = (d => d.address ?? d.segwit?.address)(JSON.parse(btcli('decodescript', funding.spkHex)));
  const rawUnsigned = btcli('-rpcwallet=step9fund', 'createrawtransaction', '[]', JSON.stringify([{ [addr]: funding.sats / 1e8 }]));
  const rawFunded = JSON.parse(btcli('-rpcwallet=step9fund', 'fundrawtransaction', rawUnsigned)).hex;
  const rawSigned = JSON.parse(btcli('-rpcwallet=step9fund', 'signrawtransactionwithwallet', rawFunded)).hex;
  node.fundingComplete(rawSigned);
  for (let i = 0; i < 200 && !ready; i++) { if (i % 20 === 5) await mine(1); await node.tick(); await new Promise(r => setTimeout(r, 300)); }
} else {
  for (let i = 0; i < 100 && !node.usableChannels().length; i++) { await node.tick(); await new Promise(r => setTimeout(r, 200)); }
  ready = node.usableChannels().length > 0;
  console.log('  restored channel usable:', ready);
}
if (!ready) { console.error('no usable channel'); process.exit(1); }
console.log('  balance', JSON.stringify(node.balance()));

// канал открыли МЫ → у нас outbound, у алисы inbound=0 с её стороны? Нет: наш канал = наш local.
// Для ПРИЁМА под H нужен inbound — в init его нет (мы фандеры). Поэтому в init шлём ПЛАТЁЖ АЛИСЕ
// (исходящий путь), а hold-приём проверяем в resume (после того как алиса вернёт часть).
if (MODE === 'init') {
  const inv = (await alice('addinvoice', '--amt', '50000')).payment_request;
  let sent = false, failed = false;
  node.on.paymentSent = () => { sent = true; };
  node.on.paymentFailed = () => { failed = true; };
  const payHash = node.payInvoice(inv);
  console.log('  pay initiated, hash', payHash.slice(0, 12) + '…');
  for (let i = 0; i < 200 && !sent && !failed; i++) { await node.tick(); await new Promise(r => setTimeout(r, 200)); }
  console.log('  payment', sent ? 'SENT ✅' : failed ? 'FAILED' : 'timeout');
  for (let i = 0; i < 10; i++) { await node.tick(); await new Promise(r => setTimeout(r, 200)); }
  await node.flushManager();
  const vlist = await vss.list();
  console.log('  VSS keys:', vlist.map(x => `${x.key}@v${x.version}`).join(', '));
  console.log(sent ? 'STEP9 INIT OK ✅' : 'STEP9 INIT FAILED');
  process.exit(sent ? 0 : 1);
} else {
  // теперь у нас есть inbound (алиса получила 50k в init) → hold-инвойс под внешний H
  const bolt11 = node.createInvoice(30000, 'step9 hold', H);
  console.log('  hold invoice', bolt11.slice(0, 24) + '…');
  const payer = new Promise(res => execFile(LNCLI_A[0], [...LNCLI_A.slice(1), 'payinvoice', '--force', '--timeout', '45s', bolt11], () => res(null)));
  for (let i = 0; i < 250 && !claimed; i++) { await node.tick(); await new Promise(r => setTimeout(r, 200)); }
  await payer;
  const pay = (await alice('listpayments')).payments.at(-1);
  console.log('  alice payment', pay.status, '| preimage match', pay.payment_preimage === R.toString('hex'));
  await node.flushManager();
  console.log(claimed ? 'STEP9 RESUME OK ✅' : 'STEP9 RESUME FAILED');
  process.exit(claimed ? 0 : 1);
}
