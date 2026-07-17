// watchdog.mjs — вахтенный смоук nv3-стека (запускается systemd-таймером раз в 2 минуты).
// Сегодняшний урок (2026-07-17): цепь дважды вставала МОЛЧА — майнер собирал блоки, которые
// узел отвергал, и никто не знал, пока пользователь не прислал скриншот. Этот скрипт ловит
// весь тот класс: узел жив, мемпул не застрял, блоки идут, дрейф времени в норме, relay и
// фронт отвечают. Алерты уходят Web-Push'ем на ВСЕ подписки кошелька (та же инфраструктура,
// что пингует «ваш ход» в свопах) и дублируются в watchdog.log.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadOrCreateVapid, sendPush } from '../../research/nversion3/webpush.mjs';

const DATADIR = process.env.NV3_DATADIR ?? '/root/nv3-public';
const RPCPORT = Number(process.env.NV3_RPCPORT ?? 19660);
const STATE_FILE = `${DATADIR}/watchdog-state.json`;
const LOG_FILE = `${DATADIR}/watchdog.log`;
const REALERT_MS = 30 * 60e3;          // повторный алерт по всё ещё горящей проблеме
const STALL_S = 240;                   // мемпул-транзакция старше этого = цепь не подтверждает
const HEARTBEAT_S = 20 * 60;           // высота не менялась дольше = heartbeat умер (норма 10 мин)
const DRIFT_S = 6600;                  // tip.time - now выше = скоро упрёмся в консенсусные 2ч

const log = m => { try { appendFileSync(LOG_FILE, `${new Date().toISOString()} ${m}\n`); } catch {} };

// ---- nv3 node RPC (cookie auth) ----
async function rpc(method, ...params) {
  const cookie = Buffer.from(readFileSync(`${DATADIR}/signet/.cookie`)).toString('base64');
  const res = await fetch(`http://127.0.0.1:${RPCPORT}/`, {
    method: 'POST', headers: { Authorization: `Basic ${cookie}` },
    body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const http = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
};

// ---- проверки: каждая возвращает null (ок) или строку-описание проблемы ----
const checks = {
  async node() {
    await rpc('getblockchaininfo');
    return null;
  },
  async stall() {
    const mp = await rpc('getrawmempool', true).catch(() => null);
    if (!mp) return null;                       // узел недоступен — это заметит check node
    const now = Date.now() / 1000;
    const ages = Object.values(mp).map(e => now - e.time);
    const oldest = ages.length ? Math.max(...ages) : 0;
    return oldest > STALL_S ? `мемпул застрял: ${ages.length} tx, старейшая ждёт ${Math.round(oldest / 60)} мин` : null;
  },
  async heartbeat(state) {
    const h = await rpc('getblockcount').catch(() => null);
    if (h === null) return null;
    const s = state.height ?? {};
    if (s.h !== h) { state.height = { h, at: Date.now() }; return null; }
    const stuckMin = (Date.now() - s.at) / 60e3;
    return stuckMin > HEARTBEAT_S / 60 ? `блоки не идут: высота ${h} уже ${Math.round(stuckMin)} мин` : null;
  },
  async drift() {
    const tip = await rpc('getbestblockhash').catch(() => null);
    if (!tip) return null;
    const hdr = await rpc('getblockheader', tip);
    const d = hdr.time - Date.now() / 1000;
    return d > DRIFT_S ? `дрейф времени цепи +${Math.round(d / 60)} мин — майнер скоро встанет (потолок 120)` : null;
  },
  async relay() {
    const r = await http('http://127.0.0.1:5181/api/info');
    const j = await r.json();
    const h = await rpc('getblockcount').catch(() => null);
    if (h !== null && h - j.height > 3) return `relay отстал: индекс ${j.height}, цепь ${h}`;
    return null;
  },
  async miner() {
    try { execFileSync('systemctl', ['is-active', '--quiet', 'fw-nv3-miner']); return null; }
    catch { return 'fw-nv3-miner не активен'; }
  },
  async web() {
    await http('https://freicoin.ru/');
    return null;
  },
  async mainRelay() {
    await http('http://127.0.0.1:5183/api/info');
    return null;
  },
};

// ---- алерты: web-push на все подписки кошелька + лог; антиспам через state ----
async function notify(title, body) {
  log(`ALERT ${title}: ${body}`);
  let subs = {};
  try { subs = JSON.parse(readFileSync(`${DATADIR}/push-subs.json`, 'utf8')); } catch {}
  const vapid = loadOrCreateVapid(`${DATADIR}/vapid.json`);
  for (const rec of Object.values(subs)) {
    try { await sendPush(vapid, rec.sub, { title, body, id: 'fw-watchdog' }); } catch (e) { log(`push failed: ${e.message}`); }
  }
}

let state = {};
try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}
state.alerts ??= {};

const failures = [];
for (const [name, fn] of Object.entries(checks)) {
  let problem = null;
  try { problem = await fn(state); } catch (e) { problem = String(e.message ?? e).slice(0, 120); }
  const a = state.alerts[name] ?? {};
  if (problem) {
    failures.push(`${name}: ${problem}`);
    const due = !a.failing || (Date.now() - (a.lastAlertAt ?? 0)) > REALERT_MS;
    state.alerts[name] = { failing: true, lastAlertAt: due ? Date.now() : a.lastAlertAt, problem };
    if (due) await notify('⚠ Freimarkets watchdog', problem);
  } else {
    if (a.failing) await notify('✅ Freimarkets watchdog', `${name}: восстановилось (было: ${a.problem})`);
    state.alerts[name] = { failing: false };
  }
}

writeFileSync(STATE_FILE, JSON.stringify(state));
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('all checks green');
