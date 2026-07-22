// relay-feed.mjs — чейн-фид браузерного LN-узла с НАШЕГО реле (фаза 2, mainnet).
// Публичный BIP157 нам недоступен (pruned-узел не может достроить blockfilterindex), поэтому
// реле само считает BIP158-фильтры для новых блоков (bip158.mjs buildFilter, бит-в-бит с Core)
// и отдаёт их + заголовки + сами блоки по JSON API. Этот класс — та же роль, что у BtcNeutrino
// в спайке: держит watch-set LDK-адаптера, матчит фильтры, скармливает адаптеру совпавшие блоки.
// Модель доверия: реле может СКРЫТЬ блок (задержать обнаружение) — как и любой Electrum-сервер, —
// но не может подделать транзакцию (LDK проверяет содержимое), а VSS-бэкап и он-чейн таймлоки
// ограничивают ущерб. Файл браузерного сорта: ни одного node-импорта.
import { Buffer } from 'buffer';
import { filterMatchesAny } from '../net/bip158.mjs';
import { parseBtcBlock } from '../net/btc-block.mjs';

export class RelayChainFeed {
  /** @param {{api:(path:string,body?:any)=>Promise<any>, adapter:any, fromHeight?:number,
   *           onHeight?:(h:number)=>void, log?:Function}} o
   *  api — функция запроса к реле (та же, что у всего кошелька); adapter — LdkChainAdapter;
   *  fromHeight — с какой высоты кормить (birthday/последняя обработанная+1; null = c вершины);
   *  onHeight — колбэк хозяину после каждой обработанной высоты (для персиста прогресса). */
  constructor({ api, adapter, fromHeight = null, onHeight = null, log = () => {} }) {
    this.api = api; this.adapter = adapter; this.log = log; this.onHeight = onHeight;
    this.next = fromHeight;        // следующая высота к обработке
    this.lastHash = null;          // хеш последнего обработанного блока (реорг-детект)
    this.tip = -1;
    this._busy = false;
  }

  async connect() {
    const st = await this.api('btcFeedStatus');
    if (st.tip == null || st.tip < 0) throw new Error('фид реле пуст');
    this.tip = st.tip;
    if (this.next == null) this.next = st.tip;                 // свежий кошелёк: история не нужна
    if (st.start != null && this.next < st.start) {
      // окно фида уехало дальше нашего прогресса: старые блоки уже не получить. Для свежего
      // узла это просто новый анкер; для узла с каналами хозяин обязан отработать это как
      // «требуется ресинк по VSS» (мониторы переиграют состояние с текущей вершины).
      this.log(`фид начинается с ${st.start}, наш прогресс ${this.next} — переанкериваемся`);
      this.next = st.start; this.lastHash = null;
    }
    return this;
  }

  /** один проход: догнать вершину фида. Повторный вход безопасен (busy-гвард). */
  async tick() {
    if (this._busy) return; this._busy = true;
    try {
      const st = await this.api('btcFeedStatus').catch(() => null);
      if (st?.tip != null) this.tip = st.tip;
      while (this.next <= this.tip) {
        const batch = await this.api('btcFeedFilters', { from: this.next, count: 96 });
        if (!batch.filters.length) break;
        for (const rec of batch.filters) {
          // РЕОРГ: цепочка prev-хешей порвалась — откатываемся и даём хозяину переиграть
          if (this.lastHash && rec.prev !== this.lastHash) {
            this.log(`реорг на ${rec.h}: перематываем назад`);
            this.next = Math.max(0, this.next - 6); this.lastHash = null;
            return;                                            // следующий tick перечитает окно
          }
          await this._feedBlock(rec);
          this.lastHash = rec.hash; this.next = rec.h + 1;
          this.onHeight?.(rec.h);
        }
      }
    } finally { this._busy = false; }
  }

  async _feedBlock(rec) {
    const hdr = Buffer.from(rec.hdr, 'hex');
    const spks = [...this.adapter.watchedSpks];
    const hit = spks.length && filterMatchesAny(Buffer.from(rec.f, 'hex'), rec.hash, spks);
    if (!hit) { this.adapter.tipAdvanced(hdr, rec.h); return; }
    const { hex } = await this.api('btcFeedBlock', { hash: rec.hash });
    const blk = await parseBtcBlock(Buffer.from(hex, 'hex'));   // async: txid считается WebCrypto
    const relevant = blk.txs.filter(t => this.adapter.isRelevant(t))
      .map(t => ({ index: t.index, raw: t.raw }));
    this.log(`блок ${rec.h}: фильтр совпал, релевантных tx ${relevant.length}/${blk.txs.length}`);
    this.adapter.blockConnected(hdr, rec.h, relevant);
  }
}
