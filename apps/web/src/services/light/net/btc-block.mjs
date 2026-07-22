// btc-block.mjs — сплиттер БИТКОИН-блока для LN-фида: сырой блок → [{index, raw, txid, outs}].
// Нужен LDK-адаптеру: из совпавшего по BIP158 блока он отдаёт transactions_confirmed только
// релевантные транзакции с их порядковым индексом. Диалект именно Bitcoin: segwit-маркер 0x00
// (у Freicoin 0xff) и БЕЗ хвостового lock_height — поэтому наш core/tx.mjs здесь не подходит.
// Файл браузерного сорта: только Uint8Array/DataView, никаких node-импортов.

const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);

function readVarint(b, o) {
  const first = b[o];
  if (first < 0xfd) return [first, o + 1];
  if (first === 0xfd) return [dv(b).getUint16(o + 1, true), o + 3];
  if (first === 0xfe) return [dv(b).getUint32(o + 1, true), o + 5];
  return [Number(dv(b).getBigUint64(o + 1, true)), o + 9];
}

async function sha256d(bytes) {
  const a = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', a));
}

/** Пройти одну BTC-транзакцию с позиции o. Возвращает { end, segwit, spans, outs }:
 *  spans — байтовые границы для txid (без witness: version + ins + outs + locktime),
 *  outs — hex-скрипты выходов. */
function walkTx(b, o) {
  const start = o;
  o += 4;                                                   // version
  let segwit = false;
  if (b[o] === 0x00 && b[o + 1] === 0x01) { segwit = true; o += 2; }
  const insStart = o;
  let [nIn, o1] = readVarint(b, o); o = o1;
  for (let i = 0; i < nIn; i++) {
    o += 36;                                                // prevout
    const [slen, o2] = readVarint(b, o); o = o2 + slen;     // scriptSig
    o += 4;                                                 // sequence
  }
  const outs = [];
  let [nOut, o3] = readVarint(b, o); o = o3;
  for (let i = 0; i < nOut; i++) {
    o += 8;                                                 // value
    const [slen, o4] = readVarint(b, o);
    outs.push(Array.from(b.subarray(o4, o4 + slen), x => x.toString(16).padStart(2, '0')).join(''));
    o = o4 + slen;
  }
  const outsEnd = o;
  if (segwit) {
    for (let i = 0; i < nIn; i++) {
      let [nItems, o5] = readVarint(b, o); o = o5;
      for (let j = 0; j < nItems; j++) { const [ilen, o6] = readVarint(b, o); o = o6 + ilen; }
    }
  }
  o += 4;                                                   // locktime
  return { end: o, segwit, spans: { start, insStart, outsEnd, lockStart: o - 4 }, outs };
}

/** Разобрать сырой блок: header (80 байт) + транзакции.
 *  → { headerHex, txs: [{ index, raw: Uint8Array, txid: hex(display), outs: hex[] }] } */
export async function parseBtcBlock(block) {
  const b = block instanceof Uint8Array ? block : new Uint8Array(block);
  let o = 80;
  let [count, o1] = readVarint(b, o); o = o1;
  const txs = [];
  for (let index = 0; index < count; index++) {
    const t = walkTx(b, o);
    const raw = b.subarray(o, t.end);
    // txid = sha256d по СТРИПНУТОЙ сериализации (version ++ ins..outs ++ locktime)
    let stripped = raw;
    if (t.segwit) {
      stripped = new Uint8Array((t.spans.insStart - t.spans.start - 2) + (t.spans.outsEnd - t.spans.insStart) + 4);
      stripped.set(b.subarray(t.spans.start, t.spans.start + 4), 0);                                   // version
      stripped.set(b.subarray(t.spans.insStart, t.spans.outsEnd), 4);                                  // ins+outs
      stripped.set(b.subarray(t.spans.lockStart, t.spans.lockStart + 4), stripped.length - 4);         // locktime
    }
    const txid = Array.from((await sha256d(stripped)).reverse(), x => x.toString(16).padStart(2, '0')).join('');
    txs.push({ index, raw, txid, outs: t.outs });
    o = t.end;
  }
  return { headerHex: Array.from(b.subarray(0, 80), x => x.toString(16).padStart(2, '0')).join(''), txs };
}
