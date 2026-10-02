// Talking to the desktop agent over loopback.
//
// Connect-per-burst, never held open. Under MV3 the background service worker is
// killed after ~30s idle, so a socket opened once and kept would die with it —
// quietly, usually within a minute of the browser going quiet. Keeping it alive
// would mean a keepalive under 30s forever, which pins the worker resident on
// every machine running the agent. The desktop keeps no per-connection state
// beyond "did the hello happen", so a socket per report is the cheaper side of
// that trade for both of us.
//
// The token comes from the desktop itself, over native messaging (see
// `pairing.ts`); nobody copies it anywhere. WebSockets have no CORS, which is why
// this path needs no host permission at all.
//
// Everything here fails silently. The bridge stops the two products warning about
// one copy twice; nothing about the paste guard may depend on the agent being
// installed, running, or reachable.

import { storage } from '#imports';
import { siDebug } from '@/lib/debug';
import { bridgeProof, equalProof } from './auth';
import { allowedMac, dedupMac, handledFrame, isHex256, queryAllowedFrame } from './hash';
import { pairingToken, undoSyncItem } from './pairing';
import { BRIDGE_PORTS, type BrowserUrlMessage, HANDLED_TTL_MS } from './types';

/** How long any single socket may take to get from open to sent. */
const CONNECT_TIMEOUT_MS = 1500;

/**
 * How long a paste may wait on the desktop's answer to `query_allowed`. The
 * warning is held back for this long at most, so it is short: no answer means
 * the warning is shown, which is what happens without a desktop app anyway.
 */
const QUERY_TIMEOUT_MS = 500;

/** A frame the desktop does not know and drops: reaching `welcome_v2` is the point. */
const PING_FRAME = JSON.stringify({ type: 'ping' });

type Reply = { type?: string; ok?: boolean };

/**
 * The port we last got a `welcome` from, cached in session storage so a worker
 * that gets killed between reports doesn't rescan the range. RAM-only and gone
 * with the browser session, which is right for a value belonging to one run of a
 * local process.
 */
const pairedPortItem = storage.defineItem<number | null>('session:si_bridge_port', {
  fallback: null,
});

/**
 * How one attempt ended. `refused` means something answered the handshake but
 * does not hold our token: the desktop was reinstalled with a new one, or the
 * port belongs to something else. `unreachable` is everything else.
 */
type Outcome = 'ok' | 'refused' | 'unreachable';

/**
 * Open a socket, complete the handshake, send one frame, close. With `ask`, the
 * socket stays open for the desktop's one reply to that frame, which `ask.onReply`
 * receives; no reply inside `ask.deadlineMs` is `unreachable`.
 */
function speak(
  port: number,
  token: string,
  frame: string,
  ask?: { deadlineMs: number; onReply: (reply: Reply) => void },
): Promise<Outcome> {
  return new Promise((resolve) => {
    let settled = false;
    let asked = false;
    const done = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Already closing; the result is what matters.
      }
      resolve(outcome);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      return resolve('unreachable');
    }
    const timer = setTimeout(() => done('unreachable'), ask?.deadlineMs ?? CONNECT_TIMEOUT_MS);

    const nonce = crypto.randomUUID();
    let authenticated = false;
    let challenged = false;
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'hello_v2', nonce }));
      } catch {
        done('unreachable');
      }
    };
    ws.onerror = () => done('unreachable');
    // Closed before a welcome. After we authenticated, that is the agent turning
    // our proof down.
    ws.onclose = () => done(authenticated ? 'refused' : 'unreachable');
    ws.onmessage = async (ev) => {
      if (settled) return;
      let msg: { type?: string; ok?: boolean; nonce?: string; proof?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // malformed frames are ignored, not fatal
      }
      if (asked) {
        ask?.onReply(msg);
        return done('ok');
      }
      if (msg.type === 'challenge_v2' && !challenged) {
        challenged = true;
        if (typeof msg.nonce !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(msg.nonce))
          return done('unreachable');
        try {
          const expected = await bridgeProof(token, 'server', nonce, msg.nonce);
          if (settled) return;
          if (!equalProof(msg.proof, expected)) return done('refused');
          const proof = await bridgeProof(token, 'client', nonce, msg.nonce);
          if (settled) return;
          authenticated = true;
          ws.send(JSON.stringify({ type: 'authenticate_v2', proof }));
        } catch {
          done('unreachable');
        }
        return;
      }
      if (msg.type !== 'welcome_v2' || !authenticated) return done('unreachable');
      if (!msg.ok) return done('refused'); // token refused
      try {
        asked = ask !== undefined;
        ws.send(frame);
        if (!ask) done('ok');
      } catch {
        done('unreachable');
      }
    };
  });
}

/**
 * Send one frame with `token`, finding the agent if we have to.
 *
 * Tries the remembered port, then the range. The peer must prove possession of
 * the key before receiving any activity, so a port squatter is `refused` and the
 * search moves on past it.
 */
async function sendWith(
  token: string,
  frame: (token: string) => Promise<string>,
): Promise<Outcome> {
  const body = await frame(token);
  let refused = false;
  const cached = await pairedPortItem.getValue();
  if (cached !== null) {
    const r = await speak(cached, token, body);
    if (r === 'ok') return 'ok';
    refused ||= r === 'refused';
  }
  for (const port of BRIDGE_PORTS) {
    if (port === cached) continue; // just tried it
    const r = await speak(port, token, body);
    if (r === 'ok') {
      await pairedPortItem.setValue(port);
      siDebug('bridge', `paired on ${port}`);
      return 'ok';
    }
    refused ||= r === 'refused';
  }
  // Forget a port that stopped answering, so the next report starts from the top
  // rather than retrying somewhere nothing is listening.
  if (cached !== null) await pairedPortItem.setValue(null);
  return refused ? 'refused' : 'unreachable';
}

/**
 * Send one frame to the agent. With no desktop app to pair with, nothing is
 * opened at all. If the token we hold is refused, the desktop is asked for its
 * current one and the send is tried once more.
 */
async function send(frame: (token: string) => Promise<string>): Promise<boolean> {
  const token = await pairingToken();
  if (!token) return false; // no desktop app; nothing to say and no way to say it
  const first = await sendWith(token, frame);
  if (first !== 'refused') return first === 'ok';
  const fresh = await pairingToken({ fresh: true });
  if (!fresh || fresh === token) return false;
  return (await sendWith(fresh, frame)) === 'ok';
}

/**
 * Report where the focused tab is, so the desktop can recognise a local dev
 * server and not alert on a copy destined for one.
 *
 * `url` is the origin and nothing more. Resolves false when there is no agent,
 * which is the normal case rather than an error.
 */
export function sendBrowserUrl(
  host: string,
  port: number | null,
  scheme = 'http',
): Promise<boolean> {
  const origin = port === null ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
  const message: BrowserUrlMessage = {
    type: 'browser_url',
    url: origin,
    host,
    port,
    ts: Date.now(),
  };
  const body = JSON.stringify(message);
  return send(async () => body);
}

/**
 * Tell the desktop we have dealt with this copy, so it doesn't raise its own
 * alert for the same one.
 *
 * Takes the SHA-256 digest the content script computed from the paste, so the
 * pasted text never crosses between extension contexts. The digest itself does
 * not go on the wire either: it is keyed with the pairing token into the MAC the
 * desktop matches (see `hash.ts`), which is worthless without the token.
 */
export function sendHandled(digestHex: string, ttlMs = HANDLED_TTL_MS): Promise<boolean> {
  if (!isHex256(digestHex)) return Promise.resolve(false);
  return send(async (token) => handledFrame(await dedupMac(token, digestHex), ttlMs));
}

/**
 * Ask the desktop whether the person restored this exact text there with Undo in
 * the last minute, in which case warning about it again would be asking a
 * question they have just answered.
 *
 * Only the port already paired on is asked, once, with a short deadline: the
 * paste is waiting on this. Anything but a clear yes is a no.
 */
export async function queryAllowed(digestHex: string): Promise<boolean> {
  if (!isHex256(digestHex) || !(await undoSyncItem.getValue())) return false;
  const port = await pairedPortItem.getValue();
  const token = await pairingToken();
  if (port === null || !token) return false;
  let allowed = false;
  await speak(port, token, queryAllowedFrame(await allowedMac(token, digestHex)), {
    deadlineMs: QUERY_TIMEOUT_MS,
    onReply: (reply) => {
      allowed = reply.type === 'allowed' && reply.ok === true;
    },
  });
  return allowed;
}

/**
 * Whether a desktop app is there and answering right now: asked afresh for its
 * token (so switching the link off in the desktop app shows at once), then one
 * handshake. For the popup, which says nothing about the desktop otherwise.
 */
export async function desktopConnected(): Promise<boolean> {
  const token = await pairingToken({ fresh: true });
  if (!token) return false;
  return (await sendWith(token, async () => PING_FRAME)) === 'ok';
}
