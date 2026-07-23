// lightning.mjs — сервис ⚡-счёта фазы 2 (LN-узел в кошельке), БЕЗ собственного UI: по нашему
// правилу фичи живут внутри существующих потоков. Баланс — строкой в карте активов, приём —
// в «Получить», оплата — в «Отправить» (вставленный bolt11 распознаётся сам), канал — в настройках.
// Здесь: автозапуск узла, кэш статуса, склейка funding-tx с BTC-счётом, тосты по событиям.
import { tr } from '@/services/i18n.mjs';
import { ctx, api } from '@/state/market-ctx.mjs';
import { btcBuildTx } from '@/services/market/btc-account.mjs';
import { toast } from '@/components/toast.mjs';
import { lnStart, lnStatus, lnRunning, lnInvoice, lnPayBolt11, lnOpenChannel, lnFundingComplete, lnOn } from '@/services/light/ln/ln-client.mjs';
import { sha256 } from '@core/crypto.mjs';
import { Buffer } from 'buffer';

// наш LSP = fw-lnd на freicoin.ru (алиас freicoin.ru-swap); канал к нему — единственный маршрут,
// который нужен встроенному узлу (никакого gossip)
const LSP_NODE_ID = '032a2826fec45df24589dcabc119d60b1f4be3963016ad184db7a1225c64e40fdc';
const lspWsUrl = () => (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws/lnd';

let wired = false, last = null, pollT = null;

/** кэш последнего статуса узла (null = не запущен) — для синхронной отрисовки строк баланса */
export const lnLast = () => last;

async function refreshStatus() {
  try { const s = await lnStatus(); last = s.running ? s : null; } catch { last = null; }
  globalThis.__fwLnSats = last?.outSats ?? 0;   // строки баланса берут отсюда (btcRowHtml)
  document.dispatchEvent(new CustomEvent('fw-ln-status'));   // строки баланса перерисуются
}

// Автозапуск БЕЗ кнопки: кошелёк разблокирован на mainnet → узел поднимается сам, в фоне,
// с небольшой задержкой (не толкаемся с первичной синхронизацией за канал). Wasm-ассет (14,5МБ)
// хэширован и кэшируется браузером — качается один раз. При живом канале узел ОБЯЗАН следить
// за цепью, пока кошелёк открыт (пропущенный revoked-commitment = потеря денег), так что
// автозапуск — это ещё и правильная безопасность, а не только UX.
export function maybeAutoStartLn() {
  try {
    if (lnRunning() || !ctx.seed) return;
    setTimeout(() => { if (!lnRunning() && ctx.seed) ensureLnNode().catch(() => {}); }, 4000);
  } catch {}
}

export async function ensureLnNode() {
  if (lnRunning()) return lnStatus();
  const st = await api('btcFeedStatus');
  if (st.tip == null) throw new Error(tr('relay chain feed is not ready'));
  // отдельный 32-байтовый LDK-сид из сида кошелька (домен-разделение: компрометация LN-ключей
  // не выдаёт ключи монет, и наоборот)
  const seedBytes = new Uint8Array(sha256(Buffer.from(ctx.seed + ':fw-ln-node', 'utf8')));
  if (!wired) {
    wired = true;
    lnOn('fundingReady', async ({ spkHex, sats }) => {
      try { const { rawtx } = await btcBuildTx(spkHex, sats); await lnFundingComplete(rawtx); refreshStatus(); }
      catch (e) { toast(tr('channel funding failed') + ': ' + e.message, 'err'); }
    });
    lnOn('channelReady', () => { toast(tr('⚡ channel is ready'), 'ok'); refreshStatus(); });
    lnOn('paymentClaimed', () => { toast(tr('⚡ payment received'), 'ok'); refreshStatus(); });
    lnOn('paymentSent', () => { toast(tr('⚡ payment sent'), 'ok'); refreshStatus(); });
    lnOn('paymentFailed', () => { toast(tr('⚡ payment failed'), 'err'); refreshStatus(); });
  }
  const r = await lnStart({ seedBytes, net: 'btcmain', apiBase: location.origin + '/api-main', lspWsUrl: lspWsUrl(), lspNodeId: LSP_NODE_ID, anchor: { hash: st.tipHash, height: st.tip } });
  clearInterval(pollT); pollT = setInterval(refreshStatus, 15e3);
  refreshStatus();
  return r;
}

/** инвойс на приём (вкладка «Получить») */
export async function lnMakeInvoice(sats = null) { await ensureLnNode(); return (await lnInvoice(sats, 'freicoin.ru wallet')).bolt11; }
/** оплата вставленного bolt11 (вкладка «Отправить») */
export async function lnPayBolt(bolt11) { await ensureLnNode(); return lnPayBolt11(bolt11.trim().replace(/^lightning:/i, '')); }
/** открыть канал к LSP из BTC-счёта (настройки) */
export async function lnOpenChannelSats(sats) { await ensureLnNode(); return lnOpenChannel(sats); }
/** строка выглядит как bolt11-инвойс? (детект в поле адреса «Отправить») */
export const looksLikeBolt11 = s => /^(lightning:)?lnbc[0-9a-z]{20,}/i.test(String(s || '').trim());
