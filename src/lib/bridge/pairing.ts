// Getting the pairing token from the desktop app, without asking anyone.
//
// The token used to be pasted into the popup by hand, behind a toggle. The
// desktop now registers itself as this extension's native messaging host
// (`ai.secureintent.desktop`), and the browser will only start that host for the
// extension ids its manifest lists. So asking it is how we pair:
//
// - No desktop app installed: the browser has no such host and the call rejects.
//   That is the common case, not an error, and nothing else happens. In
//   particular no local port is ever opened, which is what the old "off by
//   default" was protecting.
// - Installed but never run on this account: the host answers with no token.
// - Otherwise: the token, which the client then uses for the v2 handshake.
//
// The token is kept in session storage only. It is re-asked each browser session
// and never written to disk, since the desktop is where it lives.

import { browser, storage } from '#imports';
import { siDebug } from '@/lib/debug';
import { bridgeAvailableItem } from '@/settings';

/** The host name the desktop registers. Must match `native_host::HOST_NAME` there. */
export const NATIVE_HOST = 'ai.secureintent.desktop';

/** After a lookup finds no desktop app, how long before asking again. */
export const MISS_BACKOFF_MS = 60_000;

const tokenItem = storage.defineItem<string | null>('session:si_bridge_token', { fallback: null });
const missAtItem = storage.defineItem<number>('session:si_bridge_miss_at', { fallback: 0 });

type PairingReply = { type?: unknown; token?: unknown };

/** A token the desktop wrote is a UUID; accept printable ASCII of a sane length. */
const plausible = (t: unknown): t is string =>
  typeof t === 'string' && /^[\x21-\x7e]{16,128}$/.test(t);

async function askDesktop(): Promise<string | null> {
  try {
    const reply = (await browser.runtime.sendNativeMessage(NATIVE_HOST, {
      type: 'get_pairing',
      v: 1,
    })) as PairingReply | undefined;
    return reply?.type === 'pairing' && plausible(reply.token) ? reply.token : null;
  } catch {
    // "Specified native messaging host not found": no desktop app. Normal.
    return null;
  }
}

/**
 * The pairing token, or null when there is no desktop app to pair with.
 *
 * Cached for the browser session. `fresh` skips the cache and the miss backoff,
 * for when the cached token was just refused (the desktop was reinstalled) or a
 * periodic re-check wants to notice a desktop app installed since.
 */
export async function pairingToken(opts: { fresh?: boolean } = {}): Promise<string | null> {
  if (!opts.fresh) {
    const cached = await tokenItem.getValue();
    if (cached) return cached;
    if (Date.now() - (await missAtItem.getValue()) < MISS_BACKOFF_MS) return null;
  }
  const token = await askDesktop();
  await tokenItem.setValue(token);
  await missAtItem.setValue(token ? 0 : Date.now());
  // Content scripts read this to decide whether reporting the tab is worth a
  // message at all. It says only that a desktop app answered, never the token.
  await bridgeAvailableItem.setValue(token !== null);
  siDebug('bridge', token ? 'paired with the desktop app' : 'no desktop app to pair with');
  return token;
}
