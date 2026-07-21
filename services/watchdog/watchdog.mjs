// watchdog.mjs — вахтенный смоук nv3-стека (запускается systemd-таймером раз в 2 минуты).
// Сегодняшний урок (2026-07-17): цепь дважды вставала МОЛЧА — майнер собирал блоки, которые
// узел отвергал, и никто не знал, пока пользователь не прислал скриншот. Этот скрипт ловит
// весь тот класс: узел жив, мемпул не застрял, блоки идут, дрейф времени в норме, relay и
// фронт отвечают. Результат пишется в watchdog-state.json + watchdog.log — их разбирает
// ДЕЖУРНЫЙ (Claude-сессия на этом же сервере читает state по крону, чинит и эскалирует
// пользователю только когда нужно). Никаких уведомлений на клиентов отсюда не уходит.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
  // ---- посетители (метрика, не поломка): парсит nginx access.log. Раз в сутки (первый прогон
  // после 07:00 МСК) — дайджест за прошлые сутки: сколько IP грузили кошелёк, сколько дошли до
  // биржи, сколько работали с сидом, плюс список биржевых действий (тейки/офферы) за день.
  // Свои IP не исключаются (они динамические) — дежурный отфильтрует знакомых.
  async visitors(state) {
    const OWN = new Set(['78.17.151.40', '127.0.0.1']);
    const v = state.visitors ??= { known: {}, lastDigest: '' };
    let raw = '';
    try { raw = readFileSync('/var/log/nginx/access.log', 'utf8'); } catch { return null; }
    try { raw = readFileSync('/var/log/nginx/access.log.1', 'utf8') + raw; } catch {}
    const msk = t => new Date(t.getTime() + 3 * 3600e3);
    const dayOf = t => msk(t).toISOString().slice(0, 10);
    const today = dayOf(new Date()), yesterday = dayOf(new Date(Date.now() - 86400e3));
    const RX = /^(\S+) \S+ \S+ \[(\d+)\/(\w+)\/(\d+):(\d+):(\d+):\d+ [^\]]+\] "(\S+) (\S+)/;
    const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const perDay = {};   // day -> ip -> {bundle, book, seeded}
    const acts = [];
    for (const line of raw.split('\n')) {
      const m = RX.exec(line); if (!m) continue;
      const [, ip, dd, mon, yyyy, hh, mm, method, path] = m;
      if (OWN.has(ip)) continue;
      const day = dayOf(new Date(Date.UTC(+yyyy, MON[mon], +dd, +hh, +mm)));
      if (day !== today && day !== yesterday) continue;
      const rec = ((perDay[day] ??= {})[ip] ??= { bundle: 0, book: 0, seeded: 0 });
      if (method === 'GET' && /^\/assets\/index-[\w-]+\.js/.test(path)) rec.bundle++;
      else if (path.startsWith('/api/p2pList') || path.startsWith('/api/info')) rec.book++;
      else if (method === 'POST' && /^\/api(-main)?\/(btcAccount|utxos|btcHistory)/.test(path)) rec.seeded++;
      if (method === 'POST' && /^\/api(-main)?\/(p2pTake|p2pTakeB|p2pPost)/.test(path))
        acts.push(`${ip} ${msk(new Date(Date.UTC(+yyyy, MON[mon], +dd, +hh, +mm))).toISOString().slice(5, 16).replace('T', ' ')} МСК ${path}`);
    }
    // раз в сутки: дайджест за вчера (МСК), после 07:00
    if (v.lastDigest !== today && msk(new Date()).getUTCHours() >= 7) {
      const d = perDay[yesterday] ?? {};
      const ips = Object.entries(d).filter(([, r]) => r.bundle > 0);
      const fresh = ips.filter(([ip]) => !v.known[ip]);
      for (const [ip] of ips) v.known[ip] ??= yesterday;
      const book = ips.filter(([, r]) => r.book > 0).length, seeded = ips.filter(([, r]) => r.seeded > 0).length;
      v.lastDigest = today;
      const dayActs = acts.filter(a => a.includes(`${yesterday.slice(5)} `));
      if (ips.length) await notify('📊 посетители за вчера',
        `${ips.length} IP грузили кошелёк (новых ${fresh.length}), до биржи дошли ${book}, с сидом работали ${seeded}: ${ips.map(([ip, r]) => `${ip}(${r.bundle}/${r.book}/${r.seeded})`).join(' ').slice(0, 220)}${dayActs.length ? ` · биржевые действия: ${dayActs.join('; ').slice(0, 200)}` : ''}`);
    }
    return null;   // метрика ничего не «ломает»
  },
};

// ---- алерты: только state-файл + лог (их разбирает дежурная Claude-сессия) ----
async function notify(title, body) {
  log(`ALERT ${title}: ${body}`);
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
