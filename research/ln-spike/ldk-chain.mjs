// ldk-chain.mjs — адаптер «neutrino → LDK»: мост между нашим лёгким клиентом (BIP157/158:
// заголовки + фильтры + СОВПАВШИЕ блоки) и чейн-интерфейсами LDK (Filter + Confirm).
// Полные блоки НЕ нужны: LDK регистрирует через Filter, что ему важно (funding-скрипты,
// коммитмент-аутпойнты), мы добавляем эти скрипты в watch-set клиента, и когда фильтр блока
// совпал — скармливаем только релевантные транзакции через transactions_confirmed.
// Файл браузерного сорта: ни одного node-импорта.
import * as ldk from 'lightningdevkit';

const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');

export class LdkChainAdapter {
  constructor() {
    /** скрипты, за которыми LDK просил следить, hex → true (их доливаем в watch-set neutrino) */
    this.watchedSpks = new Set();
    /** txid(hex, display-order) → true — заявленные register_tx */
    this.watchedTxids = new Set();
    this.onWatch = null;   // колбэк для хозяина: (spkHex) => void — долить в neutrino watch-set
    this.filter = ldk.Filter.new_impl({
      register_tx: (txid, spk) => { this.watchedTxids.add(hex(txid.slice().reverse())); this._watch(hex(spk)); },
      register_output: out => { this._watch(hex(out.get_script_pubkey())); },
    });
    this.targets = [];   // Confirm-потребители: ChannelManager + ChainMonitor
  }
  _watch(spkHex) {
    if (!spkHex || this.watchedSpks.has(spkHex)) return;
    this.watchedSpks.add(spkHex);
    this.onWatch?.(spkHex);
  }
  attach(channelManager, chainMonitor) {
    this.targets = [channelManager.as_Confirm(), chainMonitor.as_Confirm()];
  }
  /** Транзакция релевантна LN-состоянию? (выход на watched-скрипт, спенд watched-скрипта —
   *  BIP158-фильтр как раз матчит по обоим, — или заявленный txid.) prevSpks: hex-скрипты
   *  prevout'ов, если известны (neutrino их знает по своему скану; можно не передавать). */
  isRelevant(tx, prevSpks = []) {
    if (this.watchedTxids.has(tx.txid)) return true;
    if (tx.outs.some(spk => this.watchedSpks.has(spk))) return true;
    return prevSpks.some(spk => this.watchedSpks.has(spk));
  }
  /** СОВПАВШИЙ блок: header (80 байт), высота и релевантные транзакции [{index, raw}] —
   *  порядок пар по index обязателен для LDK. */
  blockConnected(header80, height, relevant) {
    const txdata = relevant
      .sort((a, b) => a.index - b.index)
      .map(t => ldk.TwoTuple_usizeTransactionZ.constructor_new(t.index, t.raw));
    for (const c of this.targets) {
      if (txdata.length) c.transactions_confirmed(header80, txdata, height);
      c.best_block_updated(header80, height);
    }
  }
  /** блок без совпадений — только продвижение вершины */
  tipAdvanced(header80, height) {
    for (const c of this.targets) c.best_block_updated(header80, height);
  }
}
