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
  };
}
