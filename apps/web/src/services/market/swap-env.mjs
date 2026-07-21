// swap-env.mjs — BROWSER adapter: builds the SwapEnv the shared swap engine (swap-drive.mjs) runs on,
// wiring the wallet's live session (market-ctx), swap-record storage (localStorage), FRC/BTC coin ops,
// on-chain verification and fees. The UI touchpoints (toast / mvRefresh / observe) are passed in by
// the caller (initMarketView) since they live in the view layer. The headless bot builds its own env
// from server-native pieces (relay HTTP + file store + core keys) and calls the SAME engine.
import { ctx, api, p2pKey, rateOf, swapNet, btcFeeFor, VB_HTLC_SPEND } from '@/state/market-ctx.mjs';
import { loadP2p, putP2p, dropP2p, addSwapHist, loadSwapHist, addRefundedFund } from '@/services/storage.mjs';
import { hostFeeCoin, sendFrcToSpk, lockAssetToHtlc } from '@/services/market/swap-lib.mjs';
import { btcFundHtlc, btcAcctPub, btcHrp, refreshBtc } from '@/services/market/btc-account.mjs';
import { verifyFrcOutput, verifyBtcOutput } from '@/services/market/verify.mjs';
import { tr } from '@/services/i18n.mjs';

/** @param {{toast:(m:string,k?:string)=>void, mvRefresh:()=>void, observe?:(rawtx:string)=>any}} ui */
export function browserSwapEnv(ui) {
  return {
    state: () => ctx.state,
    spks: () => ctx.spks,
    p2pKey, api,
    loadP2p, putP2p, dropP2p, addSwapHist, loadSwapHist, addRefundedFund,
    hostFeeCoin, sendFrcToSpk, lockAssetToHtlc,
    btcFundHtlc, btcAcctPub, btcHrp, refreshBtc,
    verifyFrcOutput, verifyBtcOutput,
    rateOf, swapNet,
    btcSpendFee: () => btcFeeFor(VB_HTLC_SPEND),
    tr,
    toast: ui.toast, mvRefresh: ui.mvRefresh, observe: ui.observe || (() => {}),
  };
}
