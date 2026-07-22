// vss-client.mjs — клиент версионного хранилища мониторов LN-каналов. Браузерного сорта
// (WebCrypto + fetch + localStorage). Релей хранит ТОЛЬКО шифртекст: ключ шифрования выводится
// из сида кошелька и наружу не уходит. Плюс локальный high-water: клиент помнит наибольшую
// записанную версию каждого ключа и ОТКАЗЫВАЕТСЯ принимать от релея версию ниже — это защита от
// rollback-атаки (восстановить устаревший монитор = отдать канал justice-транзакции контрагента).

const enc = new TextEncoder();
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** AES-GCM ключ из сида: HKDF-подобная деривация через SHA-256(seed || 'fw-vss') → importKey. */
async function deriveKey(seedBytes) {
  const material = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new Uint8Array([...seedBytes, ...enc.encode('fw-vss:aes')])));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export class VssClient {
  /** @param {{apiBase:string, nodeId:string, seedBytes:Uint8Array, hwStore?:{get,set}}} o
   *  hwStore: {get(k)->number|null, set(k,v)} для high-water; по умолчанию localStorage. */
  constructor({ apiBase, nodeId, seedBytes, hwStore }) {
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.nodeId = nodeId;
    this._keyP = deriveKey(seedBytes);
    this.hw = hwStore ?? {
      get: k => { const v = localStorage.getItem('fw_vss_hw:' + nodeId + '/' + k); return v == null ? null : +v; },
      set: (k, v) => localStorage.setItem('fw_vss_hw:' + nodeId + '/' + k, String(v)),
    };
  }
  async _call(method, body) {
    const r = await fetch(`${this.apiBase}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j;
  }
  /** Зашифровать и записать монитор под ВОЗРАСТАЮЩЕЙ версией; обновить high-water при успехе. */
  async put(key, version, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this._keyP,
      plaintext instanceof Uint8Array ? plaintext : enc.encode(plaintext)));
    const blob = b64(iv) + '.' + b64(ct);   // iv.ciphertext
    const res = await this._call('vssPut', { nodeId: this.nodeId, key, version, blob });
    this.hw.set(key, version);
    return res;
  }
  /** Прочитать и расшифровать последнюю версию. Бросает при ROLLBACK (версия релея < локального
   *  high-water) — это не «нет данных», а сигнал атаки/рассинхрона: продолжать НЕЛЬЗЯ. */
  async get(key) {
    const { version, blob } = await this._call('vssGet', { nodeId: this.nodeId, key });
    if (version < 0 || blob == null) return null;
    const hw = this.hw.get(key);
    if (hw != null && version < hw) throw new Error(`VSS ROLLBACK: релей отдал версию ${version}, знаем ${hw}`);
    const [ivB, ctB] = blob.split('.');
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB) }, await this._keyP, unb64(ctB)));
    if (version > (hw ?? -1)) this.hw.set(key, version);
    return { version, bytes: pt };
  }
  async list() { return (await this._call('vssList', { nodeId: this.nodeId })).keys; }
}
