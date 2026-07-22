// lnd-rest.mjs — минимальный клиент REST-API LND для hold-инвойсов свопа. Нулевые зависимости:
// голый https с самоподписанным сертификатом узла как CA и макаруном в заголовке. Бот — the only
// потребитель: релей к LND не прикасается вообще (он лишь доска объявлений), поэтому LN-нога
// не добавляет координатору ни доверия, ни ключей.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';

export function lndRest({ url, macaroonPath, tlsCertPath }) {
  const u = new URL(url);
  const macaroon = readFileSync(macaroonPath).toString('hex');
  const ca = tlsCertPath ? readFileSync(tlsCertPath) : undefined;
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = request({
      host: u.hostname, port: u.port || 8080, path, method,
      ca, rejectUnauthorized: !!ca,   // самоподписанный cert узла и есть наш CA
      headers: { 'Grpc-Metadata-macaroon': macaroon, 'content-type': 'application/json' },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(data); } catch { return reject(new Error(`lnd ${path}: bad json (${data.slice(0, 120)})`)); }
        if (res.statusCode >= 400 || j.error || j.message && j.code) return reject(new Error(`lnd ${path}: ${j.error ?? j.message ?? res.statusCode}`));
        resolve(j);
      });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('lnd: timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
  const b64 = hex => Buffer.from(hex, 'hex').toString('base64');
  return {
    /** hold-инвойс под ЧУЖОЙ хеш (H свопа). expiry — окно оплаты (сек); cltvExpiry — глубина
     *  CLTV удержанных HTLC (блоки BTC): должна пережить lock+claim FRC-ноги с запасом. */
    addHoldInvoice: ({ hashHex, sats, memo = '', expiry = 1800, cltvExpiry = 144 }) =>
      call('POST', '/v2/invoices/hodl', { hash: b64(hashHex), value: String(sats), memo, expiry: String(expiry), cltv_expiry: String(cltvExpiry) })
        .then(r => r.payment_request),
    /** состояние: OPEN | ACCEPTED (удержан — «оплачено») | SETTLED | CANCELED */
    lookupInvoice: hashHex => call('GET', `/v1/invoice/${hashHex}`).then(r => ({ state: r.state, amtPaidSat: r.amt_paid_sat })),
    settleInvoice: preimageHex => call('POST', '/v2/invoices/settle', { preimage: b64(preimageHex) }),
    cancelInvoice: hashHex => call('POST', '/v2/invoices/cancel', { payment_hash: b64(hashHex) }),
    getInfo: () => call('GET', '/v1/getinfo').then(r => ({ pubkey: r.identity_pubkey, synced: r.synced_to_chain, blockHeight: r.block_height })),
    /** исходящая ёмкость каналов (сат) — предел LN-выплат бота */
    channelBalance: () => call('GET', '/v1/balance/channels').then(r => BigInt(r.local_balance?.sat ?? r.balance ?? 0)),
    /** авторитетный разбор bolt11 (сеть, суммы, сроки — всё глазами нашего же узла) */
    decodePayReq: payreq => call('GET', `/v1/payreq/${encodeURIComponent(payreq)}`).then(r => ({
      paymentHash: r.payment_hash, sats: BigInt(r.num_satoshis || 0), timestamp: Number(r.timestamp), expiry: Number(r.expiry || 3600), destination: r.destination })),
    /** Оплата инвойса (SendPaymentSync). Блокируется до терминального статуса; вернувшийся
     *  preimage — криптографическая квитанция. cltvLimit ограничивает, как долго платёж может
     *  зависнуть in-flight в худшем случае (блоки BTC) — согласуется с FRC-таймлоком свопа. */
    payInvoice: ({ payreq, feeLimitSat, cltvLimit = 144, timeoutMs = 120000 }) =>
      new Promise((resolve, reject) => {
        const req = request({
          host: u.hostname, port: u.port || 8080, path: '/v1/channels/transactions', method: 'POST',
          ca, rejectUnauthorized: !!ca,
          headers: { 'Grpc-Metadata-macaroon': macaroon, 'content-type': 'application/json' },
          timeout: timeoutMs,
        }, res => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            let j; try { j = JSON.parse(data); } catch { return reject(new Error(`lnd pay: bad json (${data.slice(0, 120)})`)); }
            if (j.payment_error) return reject(new Error(`lnd pay: ${j.payment_error}`));
            if (res.statusCode >= 400 || j.error || (j.message && j.code)) return reject(new Error(`lnd pay: ${j.error ?? j.message ?? res.statusCode}`));
            if (!j.payment_preimage) return reject(new Error('lnd pay: нет preimage в ответе'));
            resolve({ preimageHex: Buffer.from(j.payment_preimage, 'base64').toString('hex') });
          });
        });
        // ВАЖНО: таймаут клиента ≠ провал платежа — он может остаться in-flight; вызывающий обязан
        // добить исход через findPayment, а не считать оплату несостоявшейся.
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('lnd pay: timeout (исход неизвестен — сверьтесь findPayment)')));
        req.write(JSON.stringify({ payment_request: payreq, fee_limit: { fixed: String(feeLimitSat) }, cltv_limit: cltvLimit, allow_self_payment: false }));
        req.end();
      }),
    /** исход платежа по hash: {status:'SUCCEEDED'|'FAILED'|'IN_FLIGHT'|null, preimageHex} */
    findPayment: async hashHex => {
      const r = await call('GET', '/v1/payments?include_incomplete=true&reversed=true&max_payments=50');
      const p = (r.payments || []).find(x => x.payment_hash === hashHex);
      if (!p) return { status: null, preimageHex: null };
      return { status: p.status, preimageHex: p.payment_preimage && /^0*[1-9a-f]/.test(p.payment_preimage) ? p.payment_preimage : null };
    },
  };
}
