// land.mjs — Freiland (реестр имён) на стороне кошелька. Имя = уникальный слот; залог = FRC на
// СВОЁМ land-ключе (тает демерреджем = рента); резолв = адрес, куда указывает имя. Регистрация:
// запереть залог на land-адресе → подписать land-ключом → landRegister у релея. Резолв: landLookup.
// Владение доказывается подписью land-ключа; залог обязан быть на его же wpk-адресе (релей сверяет).
import { ctx, api } from '@/state/market-ctx.mjs';
import { sha256 } from '@core/crypto.mjs';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { frcWpkSpk, validLandName, annualRent } from '@core/freiland.mjs';
import { sendFrcToSpk } from '@/services/market/swap-lib.mjs';
import { deriveAddress } from '@/services/wallet.mjs';
import { loadLand, saveLand } from '@/services/storage.mjs';
import { Buffer } from 'buffer';

// детерминированный land-ключ на имя (как своп-нонсы, отдельным доменом от торговых ключей)
const landKey = name => sha256(Buffer.from(ctx.seed + 'fw-land:' + name, 'utf8')).toString('hex');
export const landOwnerPub = name => pubkeyCompressed(landKey(name));
export const landDepositSpk = name => frcWpkSpk(landOwnerPub(name));

export { validLandName, annualRent };

/** имя → адрес (или null). Основа резолва в «Отправить». */
export async function resolveName(name) {
  if (!validLandName(name)) return null;
  try { const r = await api('landLookup', { name }); return r.found ? r.resolve : null; }
  catch { return null; }
}

/** зарегистрировать имя: запереть залог на land-адресе, подписать, отправить в реестр.
 *  resolve по умолчанию — главный приёмный адрес. progress(msg) — для UI.
 *  @param {{name:string, valueFrc:number, resolve?:string, progress?:(p:string)=>void}} o */
export async function registerName(o) {
  const { name, valueFrc, progress = () => {} } = o;
  let { resolve } = o;
  if (!validLandName(name)) throw new Error('плохое имя');
  const valueKria = BigInt(Math.round(valueFrc * 1e8));
  const pub = landOwnerPub(name), key = landKey(name);
  resolve = resolve || deriveAddress(ctx.seed, 0, 0);
  progress('lock');
  const { txid } = await sendFrcToSpk(landDepositSpk(name), valueKria);   // vout 0 = залог
  const depTxid = txid, depVout = 0;
  const sig = signEcdsa(key, sha256(Buffer.from(`freiland:reg:${name}:${resolve}:${depTxid}:${depVout}`, 'utf8')).toString('hex'));
  progress('confirm');
  // залог должен проиндексироваться (попасть в блок) — ретраим landRegister, пока не «залог не найден»
  let last;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await api('landRegister', { name, ownerFrcPub: pub, depTxid, depVout, resolve, sig });
      const rec = { name, resolve, depTxid, depVout, value: r.value, at: Date.now() };
      const mine = loadLand().filter(x => x.name !== name); mine.push(rec); saveLand(mine);
      progress('done'); return rec;
    } catch (e) { last = e.message; if (!/не найден|не подтвержд/i.test(last)) throw e; await new Promise(r => setTimeout(r, 5000)); }
  }
  throw new Error(last || 'реестр не принял регистрацию');
}

/** мои имена (из локального реестра, сверенные с релеем на актуальную ценность/статус) */
export async function myNames() {
  const local = loadLand();
  if (!local.length) return [];
  let live = [];
  try { live = (await api('landList')).names; } catch {}
  const byName = new Map(live.map(n => [n.name, n]));
  return local.map(r => ({ ...r, ...(byName.get(r.name) || {}), mine: true }));
}

/** обновить адрес, куда указывает имя */
export async function setResolve(name, resolve) {
  const pub = landOwnerPub(name), key = landKey(name);
  const sig = signEcdsa(key, sha256(Buffer.from(`freiland:res:${name}:${resolve}`, 'utf8')).toString('hex'));
  await api('landSetResolve', { name, ownerFrcPub: pub, resolve, sig });
  const mine = loadLand().map(x => x.name === name ? { ...x, resolve } : x); saveLand(mine);
}
