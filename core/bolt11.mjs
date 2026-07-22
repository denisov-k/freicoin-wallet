// bolt11.mjs — минимальный декодер Lightning-инвойсов (BOLT11) для браузера.
// Нужен ровно для LN-выплат на sell-стороне: из вставленного пользователем инвойса достаём
// payment_hash (он станет H всего свопа), сумму в сатоши и сроки. Подпись НЕ проверяем —
// авторитетную проверку делает LND мейкера через decodepayreq; здесь только целостность
// (bech32-чексумма) и поля, без которых нельзя строить FRC HTLC.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
const hrpExpand = hrp => [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)];

/** 5-бит группы → байты (лишние хвостовые биты отбрасываются, как велит BOLT11). */
function to8bit(groups) {
  let acc = 0, bits = 0; const out = [];
  for (const g of groups) {
    acc = (acc << 5) | g; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

// множитель HRP-суммы → мсат на единицу (p обрабатывается отдельно: 0.1 мсат)
const MULT_MSAT = { m: 100000000n, u: 100000n, n: 100n };

/**
 * @param {string} inv — bolt11 строка (можно в верхнем регистре, можно с префиксом lightning:)
 * @returns {{net:string, sats:bigint|null, paymentHash:string, timestamp:number, expiry:number}}
 * net: 'bc'|'tb'|'tbs'|'bcrt'; sats null, если инвойс без суммы; expiry в секундах (дефолт 3600).
 */
export function decodeBolt11(inv) {
  let s = String(inv || '').trim().replace(/^lightning:/i, '');
  if (/[A-Z]/.test(s) && /[a-z]/.test(s)) throw new Error('инвойс смешивает регистры');
  s = s.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (!s.startsWith('ln') || pos < 3 || s.length - pos - 1 < 6 + 7) throw new Error('это не bolt11-инвойс');
  const hrp = s.slice(0, pos), dataStr = s.slice(pos + 1);
  const data = [...dataStr].map(c => CHARSET.indexOf(c));
  if (data.includes(-1)) throw new Error('недопустимый символ в инвойсе');
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('инвойс повреждён (чексумма)');

  const m = /^ln(bcrt|tbs|tb|bc)(\d*)([munp]?)$/.exec(hrp);
  if (!m) throw new Error('неизвестная сеть инвойса');
  const [, net, amtStr, mult] = m;
  let sats = null;
  if (amtStr) {
    const amt = BigInt(amtStr);
    let msat;
    if (!mult) msat = amt * 100000000000n;               // целые BTC
    else if (mult === 'p') {
      if (amt % 10n) throw new Error('слишком мелкая сумма (доли мсат)');
      msat = amt / 10n;
    } else msat = amt * MULT_MSAT[mult];
    if (msat % 1000n) throw new Error('сумма не кратна сатоши');
    sats = msat / 1000n;
  }

  const payload = data.slice(0, -6);                      // без чексуммы
  if (payload.length < 7) throw new Error('инвойс слишком короткий');
  const timestamp = payload.slice(0, 7).reduce((a, g) => a * 32 + g, 0);
  let paymentHash = null, expiry = 3600;
  for (let i = 7; i + 3 <= payload.length;) {
    const type = payload[i], len = payload[i + 1] * 32 + payload[i + 2];
    const field = payload.slice(i + 3, i + 3 + len);
    if (field.length < len) break;                        // подпись в конце короче не бывает — просто стоп
    if (type === 1 && len === 52) paymentHash = [...to8bit(field)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (type === 6) expiry = field.reduce((a, g) => a * 32 + g, 0);
    i += 3 + len;
  }
  if (!paymentHash) throw new Error('в инвойсе нет payment_hash');
  return { net, sats, paymentHash, timestamp, expiry };
}
