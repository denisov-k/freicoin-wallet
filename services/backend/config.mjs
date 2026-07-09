// config.mjs — backend configuration. Override via env vars.
import { readFileSync } from 'fs';

const env = process.env;
export const config = {
  network: env.FW_NETWORK || 'regtest',        // main | test | regtest
  rpc: {
    url: env.FW_RPC_URL || 'http://127.0.0.1:19445',
    // Either an explicit user:pass, or a cookie file to read (rpcuser fallback).
    cookiePath: env.FW_RPC_COOKIE || null,
    user: env.FW_RPC_USER || null,
    pass: env.FW_RPC_PASS || null,
  },
  // The wallet account descriptor key: an account-level xpub the backend watches.
  // The client owns the private keys; the backend only needs the xpub to derive
  // addresses, scan balances and relay signed transactions.
  accountXpub: env.FW_ACCOUNT_XPUB || null,
  port: parseInt(env.FW_PORT || '3030', 10),
};

/** Resolve RPC auth header value ("user:pass" base64), reading a cookie if given. */
export function rpcAuth() {
  const { user, pass, cookiePath } = config.rpc;
  let creds = user && pass != null ? `${user}:${pass}` : null;
  if (!creds && cookiePath) creds = readFileSync(cookiePath, 'utf8').trim();
  if (!creds) throw new Error('no RPC credentials: set FW_RPC_USER/PASS or FW_RPC_COOKIE');
  return 'Basic ' + Buffer.from(creds).toString('base64');
}
