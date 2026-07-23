// land.mjs — Freiland (реестр имён) на стороне кошелька, Model A (спека §9): владение = уникальный
// NFT-токен `land:<name>` (1 шт., тег коммитит имя ⇒ второй выпуск невозможен), ценность/рента =
// отдельный FRC-залог на land-адресе (тает демерреджем = рента), трастлесс-выкуп = стоячий
// ranged-оффер NFT ⇄ V FRC владельцу, подписанный land-ключом. Релей — только индекс/доска:
// цензурировать может, украсть нет (NFT и залог двигаются подписями, которые строим мы).
import { ctx, api, HOST_TAG } from '@/state/market-ctx.mjs';
import { sha256, hash160 } from '@core/crypto.mjs';
import { pubkeyCompressed, signEcdsa } from '@core/ecdsa.mjs';
import { frcWpkSpk, validLandName, annualRent } from '@core/freiland.mjs';
import { sendFrcToSpk, signRangedGive, signLadder, LADDER_SPAN } from '@/services/market/swap-lib.mjs';
import { deriveAddress } from '@/services/wallet.mjs';
import { loadLand, saveLand } from '@/services/storage.mjs';
import { Buffer } from 'buffer';

// детерминированный land-ключ на имя (как своп-нонсы, отдельным доменом от торговых ключей)
const landKey = name => sha256(Buffer.from(ctx.seed + 'fw-land:' + name, 'utf8')).toString('hex');
export const landOwnerPub = name => pubkeyCompressed(landKey(name));
export const landDepositSpk = name => frcWpkSpk(landOwnerPub(name));
const landSign = (key, str) => signEcdsa(key, sha256(Buffer.from(str, 'utf8')).toString('hex'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

export { validLandName, annualRent };

// Тег NFT-имени, вычисленный ЛОКАЛЬНО: тот же def, что строит релейный issue для
// {name:'land:<n>', shift:64, interest:false, decimals:0} — [shift, interest, granularity=1,
// нули, sha256(имени актива)], тег = hash160(def). Слайс до 30 символов повторяет релей.
const nftDef = name => {
  const d = Buffer.concat([Buffer.from([64, 0]), Buffer.alloc(8), sha256(Buffer.from(('land:' + name).slice(0, 30), 'utf8'))]);
  d.writeUInt8(1, 2);
  return d;
};
export const landNftTag = name => hash160(nftDef(name)).toString('hex');

/** весь реестр: [{name, ownerFrcPub, resolve, value, lapsed, nftTag, price, buyable}], + minV/height. */
export async function listNames() {
  try { return await api('landList'); } catch { return { names: [], minV: '0', height: 0 }; }
}

/** имя → адрес (или null). Основа резолва в «Отправить». */
export async function resolveName(name) {
  if (!validLandName(name)) return null;
  try { const r = await api('landLookup', { name }); return r.found ? r.resolve : null; }
  catch { return null; }
}

// Стоячий оффер Model A: отдать NFT-монету ЦЕЛИКОМ (min=max=1) за V FRC на мой главный адрес.
// Подписан land-ключом — монета лежит на land-адресе, кошельковый km её не знает. Лестница
// стандартная (LADDER_SPAN); истёкший оффер перевыставляет maybeResignLand при живом кошельке.
async function postLandOffer(name, V, nftOutpoint, refheight, height) {
  const key = landKey(name), pub = landOwnerPub(name), spk = landDepositSpk(name);
  const expireAt = height + LADDER_SPAN;
  const desc = { payoutAsset: HOST_TAG, payoutScript: ctx.spks[0], priceNum: V, priceDen: 1n,
                 changeScript: spk, minFill: 1n, maxFill: 1n, nExpireTime: expireAt };
  const coin = { spk, value: 1n, refheight };
  const ladder = await signLadder(desc, coin, nftOutpoint, height, expireAt, key);
  const { id } = await api('rangedOffer', { makerSpk: spk, giveOutpoint: nftOutpoint, desc, nExpireTime: expireAt,
    lockHeight: ladder[0].lockHeight, witness: ladder[0].witness, ladder, makerPub: pub });
  return id;
}

/** зарегистрировать имя (Model A): выпустить NFT-имя на land-адрес → запереть залог → выставить
 *  стоячий оффер (цена = V) → landRegister. resolve по умолчанию — главный приёмный адрес.
 *  @param {{name:string, valueFrc:number, resolve?:string, progress?:(p:string)=>void}} o */
export async function registerName(o) {
  const { name, valueFrc, progress = () => {} } = o;
  let { resolve } = o;
  if (!validLandName(name)) throw new Error('плохое имя');
  const V = BigInt(Math.round(valueFrc * 1e8));            // самооценка = цена выкупа, кария
  const pub = landOwnerPub(name), key = landKey(name), spk = landDepositSpk(name);
  resolve = resolve || deriveAddress(ctx.seed, 0, 0);
  // 1) NFT-имя: единственный токен `land:<name>` на land-адрес. Тег коммитит имя ⇒ выпуск ровно
  //    один раз; владение именем = владение этой монетой.
  progress('mint');
  const tag = landNftTag(name);
  let nftTxid = null, nftVout = 0;
  try { nftTxid = (await api('issue', { name: 'land:' + name, amount: 1, tokens: [name], interest: false, shift: 64, spk })).txid; }
  catch (e) {
    if (!/существует/.test(e.message || '')) throw e;
    // выпуск уже был (наш прерванный прошлый заход) — NFT обязан лежать на НАШЕМ land-адресе
    const mine = ((await api('utxos', { spks: [spk] })).utxos || []).find(u => u.assetTag === tag);
    if (!mine) throw new Error('имя уже выпущено другим владельцем — выкупайте его на доске');
    [nftTxid, nftVout] = [mine.outpoint.split(':')[0], +mine.outpoint.split(':')[1]];
  }
  // 2) залог: V + ~неделя ренты сверху. Свежий залог тает с первого же блока — без запаса релей
  //    отверг бы «V > present value залога» сразу после подтверждения.
  progress('lock');
  const { txid: depTxid } = await sendFrcToSpk(spk, V + annualRent(V) / 52n);
  const depVout = 0;
  // 3) ждём индексацию ОБЕИХ монет (refheight NFT нужен для подписи оффера)
  progress('confirm');
  let nft = null, h = 0;
  for (let i = 0; i < 120 && !nft; i++) {
    await sleep(5000);
    const r = await api('utxos', { spks: [spk] }).catch(() => null);
    if (!r) continue;
    const dep = r.utxos.find(u => u.outpoint === `${depTxid}:${depVout}`);
    const nu = r.utxos.find(u => u.outpoint === `${nftTxid}:${nftVout}`);
    if (dep && nu) { nft = nu; h = r.height; }
  }
  if (!nft) throw new Error('монеты не подтвердились — попробуйте позже ещё раз');
  // 4) стоячий оффер: NFT ⇄ V FRC мне — это и есть трастлесс-«всегда в продаже»
  progress('offer');
  const offerId = await postLandOffer(name, V, `${nftTxid}:${nftVout}`, nft.refheight, h);
  // 5) регистрация: подпись коммитит резолв+залог+NFT+V (переклеить на чужой залог/цену нельзя)
  const sig = landSign(key, `freiland:reg:${name}:${resolve}:${depTxid}:${depVout}:${tag}:${nftTxid}:${nftVout}:${V}`);
  let last;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await api('landRegister', { name, ownerFrcPub: pub, depTxid, depVout, resolve, offerId, sig,
        nftTag: tag, nftTxid, nftVout, selfValue: String(V) });
      const rec = { name, resolve, depTxid, depVout, nftTag: tag, nftTxid, nftVout, offerId, selfValue: String(V), value: r.value, at: Date.now() };
      const mine = loadLand().filter(x => x.name !== name); mine.push(rec); saveLand(mine);
      progress('done'); return rec;
    } catch (e) { last = e.message; if (!/не найден|не подтвержд/i.test(last)) throw e; await sleep(5000); }
  }
  throw new Error(last || 'реестр не принял регистрацию');
}

// Держать мои стоячие Freiland-офферы живыми (зовётся из mvRefresh на nv3):
//  • свежая ступень лестницы, как maybeResignRanged — но land-ключом (иначе покупатель с монетами
//    моложе lockHeight физически не соберёт платёж);
//  • истёкший/пропавший оффер перевыставляется, цена = min(V, текущий PV залога): самооценка
//    сползает вместе с тающим залогом — ровно харбергеровское «забросил — выкупят дёшево»;
//  • NFT ушла с land-адреса (имя выкуплено) — оффер больше не наш; запись живёт до шага 5c.
// Перевыставление — не чаще раза в 10 минут на имя: книга в info обрезана (последние 80),
// и «не вижу оффер» ещё не значит «оффер мёртв» — без троттла это спамило бы релей новым
// оффером каждый refresh. Свежая ступень (resignRanged) не троттлится — она идемпотентна.
const landRepostAt = new Map();
let landResignBusy = false;
export async function maybeResignLand() {
  if (landResignBusy || !ctx.seed || !ctx.state?.info?.book) return;
  const local = loadLand().filter(r => r.nftTag && r.offerId != null);
  if (!local.length) return;
  landResignBusy = true;
  try {
    const H = ctx.state.mine.height, book = ctx.state.info.book;
    for (const rec of local) {
      try {
        const key = landKey(rec.name), spk = landDepositSpk(rec.name);
        const o = book.find(x => x.ranged && x.id === rec.offerId);
        const exp = o ? (Number(o.nExpireTime) || 0) : 0;
        if (o && o.status === 'open' && !(exp && H > exp)) {
          if (H - o.lockHeight <= 1 || !o.give) continue;             // свежий — нечего делать
          const d = o.desc;   // digest коммитит desc — восстановить РОВНО подписанное
          const desc = { payoutAsset: d.payoutAsset ?? HOST_TAG, payoutScript: d.payoutScript,
            priceNum: BigInt(d.priceNum), priceDen: BigInt(d.priceDen), changeScript: d.changeScript,
            minFill: BigInt(d.minFill), maxFill: BigInt(d.maxFill),
            ...(d.nExpireTime != null ? { nExpireTime: Number(d.nExpireTime) } : {}) };
          const coin = { spk, value: 1n, refheight: o.give.refheight };
          const witness = signRangedGive(desc, o.giveOutpoint, coin, H, key);
          await api('resignRanged', { id: o.id, giveOutpoint: o.giveOutpoint, lockHeight: H, witness });
          continue;
        }
        // оффер истёк/пропал: NFT ещё наша? — перевыставить и перерегистрировать (offerId + цена)
        if (Date.now() - (landRepostAt.get(rec.name) ?? 0) < 600e3) continue;
        landRepostAt.set(rec.name, Date.now());
        const r = await api('utxos', { spks: [spk] });
        const nu = (r.utxos || []).find(u => u.assetTag === rec.nftTag);
        if (!nu) continue;                                            // имя выкуплено — дело шага 5c
        const dep = (r.utxos || []).find(u => u.outpoint === `${rec.depTxid}:${rec.depVout}`);
        if (!dep) continue;                                           // залог истрачен — запись мертва
        const depPv = BigInt(dep.pv), V0 = BigInt(rec.selfValue ?? '0');
        const V = depPv < V0 ? depPv : V0;
        if (V <= 0n) continue;
        const [nftTxid, nftVout] = [nu.outpoint.split(':')[0], +nu.outpoint.split(':')[1]];
        const offerId = await postLandOffer(rec.name, V, nu.outpoint, nu.refheight, r.height);
        const sig = landSign(key, `freiland:reg:${rec.name}:${rec.resolve}:${rec.depTxid}:${rec.depVout}:${rec.nftTag}:${nftTxid}:${nftVout}:${V}`);
        await api('landRegister', { name: rec.name, ownerFrcPub: landOwnerPub(rec.name), depTxid: rec.depTxid,
          depVout: rec.depVout, resolve: rec.resolve, offerId, sig, nftTag: rec.nftTag, nftTxid, nftVout, selfValue: String(V) });
        saveLand(loadLand().map(x => x.name === rec.name ? { ...x, offerId, nftTxid, nftVout, selfValue: String(V) } : x));
      } catch { /* следующий цикл дотянет */ }
    }
  } finally { landResignBusy = false; }
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
  const sig = landSign(key, `freiland:res:${name}:${resolve}`);
  await api('landSetResolve', { name, ownerFrcPub: pub, resolve, sig });
  const mine = loadLand().map(x => x.name === name ? { ...x, resolve } : x); saveLand(mine);
}
