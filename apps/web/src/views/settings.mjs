// views/settings.mjs — the Settings screen: language, theme, network/bridge, swap notifications,
// wallet-secret reveal/copy, BTC WIF export, passphrase set/change/lock, log out. Session/theme/
// network state and the lifecycle actions live in the app shell and are injected via initSettings.
import { tr, getLang, setLang, LANGS } from '@/services/i18n.mjs';
import { $, store, copy } from '@/components/dom.mjs';
import { toast } from '@/components/toast.mjs';
import { openModal, armOverlay, closeOverlay } from '@/components/modal.mjs';
import { NETWORKS, DEFAULT_BRIDGE } from '@/state/network-params.mjs';
import { enablePush, disablePush, pushSupported, pushEnabled } from '@/services/push.mjs';
import { btcExportKeys, btcToStr } from '@/services/market/btc-account.mjs';

/** deps injected by the app shell */
let d;
export const initSettings = deps => { d = deps; };

export function renderSettings() {
  const vault = d.getVault(), s = d.secret();
  const kind = /\s/.test((s || '').trim()) ? tr('recovery phrase') : tr('hex seed');
  $('#settings').innerHTML =
    `<label>${tr('Language')}<select id="langSel">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${getLang() === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
     <label>${tr('Theme')}<select id="themeSel">${['system', 'dark', 'light'].map(m => `<option value="${m}"${d.themeMode() === m ? ' selected' : ''}>${m === 'system' ? tr('System') : m === 'dark' ? tr('Dark') : tr('Light')}</option>`).join('')}</select></label>
     <label>${tr('Network')}<select id="netSel">${Object.entries(NETWORKS).filter(([k, v]) => !v.hidden || k === d.curNet()).map(([k, v]) => `<option value="${k}"${k === d.curNet() ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>
     <label>${tr('Bridge URL (neutrino P2P relay)')}<input id="br" value="${d.curBridge()}"></label>
     ${d.SWAP() && pushSupported() ? `<label class="chk"><input type="checkbox" id="pushChk"${pushEnabled() ? ' checked' : ''}>${tr('Swap notifications (your turn)')}</label>` : ''}
     <label>${tr('Wallet secret')} (${kind})<textarea id="sd" rows="2" readonly>${'•'.repeat(24)}</textarea></label>
     <div class="row"><button id="revealSeed" class="ghost">${tr('Show')}</button><button id="copySeed" class="ghost">⧉ ${tr('Copy')}</button>${d.SWAP() ? `<button id="wifBtn" class="ghost">${tr('Export key (WIF)')}</button>` : ''}</div>
     <p class="warn">${vault ? tr('🔒 Secret is encrypted with your passphrase (AES-GCM). It is only decrypted in memory.') + ' ' + tr('Auto-locks after 5 minutes of inactivity.') : tr('⚠ Secret is stored unencrypted — set a passphrase to secure it.')}</p>
     <div class="row">${vault
        ? `<button id="lockBtn" class="ghost">${tr('🔓 Lock')}</button><button id="chgBtn" class="ghost">${tr('Change passphrase')}</button>`
        : `<button id="secBtn" class="ghost">${tr('🔒 Secure with passphrase')}</button>`}</div>
     <div class="row"><button id="outBtn" class="ghost">${tr('Log out of wallet')}</button></div>`;
  $('#langSel').onchange = () => { setLang($('#langSel').value); d.renderApp(); };   // applies immediately, re-renders all
  const wifBtn = $('#wifBtn');
  if (wifBtn) wifBtn.onclick = () => {
    if (!d.secret()) { toast(tr('unlock the wallet first'), 'err'); return; }
    const rows = btcExportKeys();
    // seed-section pattern: a masked read-only field + Show/Copy. The main account comes bare;
    // extra keys (funded legacy/swap addresses) get a thin caption so they're distinguishable.
    openModal(tr('BTC keys (WIF)'),
      `<p class="warn">⚠ ${tr('Whoever has a WIF key owns its coins. Paste it only into a wallet you trust (Electrum, Sparrow, BlueWallet).')}</p>`
      + rows.map((r, i) => `
        ${i > 0 ? `<div class="sub" style="font-size:11px">${r.label} · ${r.addr.slice(0, 14)}… · ${btcToStr(r.sats)} BTC</div>` : ''}
        <label><input class="wifVal" data-i="${i}" value="${'•'.repeat(24)}" readonly></label>
        <div class="row"><button class="ghost wifShow" data-i="${i}">${tr('Show')}</button><button class="ghost wifCopy" data-i="${i}">${tr('Copy')}</button></div>`).join(''));
    // @ts-ignore — false positive (DOM under checkJs)
    document.querySelectorAll('button.wifShow').forEach((/** @type {HTMLButtonElement} */ b) => b.onclick = () => {
      const inp = /** @type {HTMLInputElement} */ (document.querySelector(`input.wifVal[data-i="${b.dataset.i}"]`));
      const hidden = inp.value.startsWith('•');
      inp.value = hidden ? rows[Number(b.dataset.i)].wif : '•'.repeat(24);
      b.textContent = hidden ? tr('Hide') : tr('Show');
    });
    // @ts-ignore — false positive (DOM under checkJs)
    document.querySelectorAll('button.wifCopy').forEach((/** @type {HTMLButtonElement} */ b) => b.onclick = async () => {
      try { await navigator.clipboard.writeText(rows[Number(b.dataset.i)].wif); toast(tr('copied ✓'), 'ok'); }
      catch { toast(tr('copy failed'), 'err'); }
    });
  };
  const pushChk = $('#pushChk');
  if (pushChk) pushChk.onchange = async () => {
    try {
      if (pushChk.checked) { await enablePush(); toast(tr('notifications on — the relay pings your turns'), 'ok'); }
      else { await disablePush(); toast(tr('notifications off'), 'ok'); }
    } catch (e) { pushChk.checked = pushEnabled(); toast(String(e?.message || e), 'err'); }
  };
  $('#themeSel').onchange = () => { const t = $('#themeSel').value; store.set('fw_theme_mode', t); d.applyTheme(t); };   // applies immediately
  // Network/bridge apply immediately too: network on select (swapping in that network's default
  // bridge), bridge on leaving the field.
  $('#netSel').onchange = () => { $('#br').value = DEFAULT_BRIDGE[$('#netSel').value] || ''; d.applyNetSettings(); };
  $('#br').onchange = d.applyNetSettings;
  // The secret never sits in the DOM while masked — Show swaps the real value in.
  let revealed = false;
  $('#revealSeed').onclick = () => {
    revealed = !revealed;
    $('#sd').value = revealed ? s : '•'.repeat(24);
    $('#revealSeed').textContent = revealed ? tr('Hide') : tr('Show');
  };
  $('#copySeed').onclick = e => copy(s, e.target);
  if (vault) { $('#lockBtn').onclick = d.lock; $('#chgBtn').onclick = () => d.passForm(tr('Change passphrase'), pw => d.secure(d.secret(), pw, true)); }
  else $('#secBtn').onclick = () => d.passForm(tr('Set a passphrase'), pw => d.secure(s, pw, false));
  $('#outBtn').onclick = () => {
    const m = document.createElement('div'); m.id = 'modal';
    m.innerHTML = `<div class="review">
      <p class="warn">${tr('This removes the wallet from this device. Without the recovery phrase the funds are UNRECOVERABLE.')}</p>
      <div class="row"><button id="outYes">${tr('Log out & wipe')}</button><button id="outNo" class="ghost">${tr('Cancel')}</button></div></div>`;
    document.body.appendChild(m);
    armOverlay(m);   // tap outside the card = cancel (ghost-tap shielded)
    // @ts-ignore — false positive (DOM/Promise<void> under checkJs)
    m.querySelector('#outNo').onclick = () => closeOverlay(m);
    // @ts-ignore — false positive (DOM/Promise<void> under checkJs)
    m.querySelector('#outYes').onclick = () => { closeOverlay(m); d.logout(); };
  };
}
