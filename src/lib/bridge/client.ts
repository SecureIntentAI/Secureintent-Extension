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
// Pairing is a token the person copies out of the desktop app's dashboard, which
// shows both the endpoint and the token. There is no HTTP handout to fetch it
// from: the desktop's local API has only `/health` and `/scan`, `/scan` already
// requires the token, and neither sends CORS headers — so a fetch from here would
// be discarded by the browser even if an endpoint existed. WebSockets have no
// CORS, which is why this path needs no host permission at all.
//
// Everything here fails silently. The bridge stops the two products warning about
// one copy twice; nothing about the paste guard may depend on the agent being
// installed, running, or reachable.

import { storage } from '#imports';
import { siDebug } from '@/lib/debug';
import { bridgeTokenItem } from '@/settings';
import { bridgeProof, equalProof } from './auth';
import { handledFrame } from './hash';
import { BRIDGE_PORTS, type BrowserUrlMessage, HANDLED_TTL_MS } from './types';

/** How long any single socket may take to get from open to sent. */
const CONNECT_TIMEOUT_MS = 1500;

/**
 * The port we last got a `welcome` from, cached in session storage so a worker
 * that gets killed between reports doesn't rescan the range. RAM-only and gone
 * with the browser session, which is right for a value belonging to one run of a
 * local process.
 */
const pairedPortItem = storage.defineItem<number | null>('session:si_bridge_port', {
  fallback: null,
});

/** Open a socket, complete the handshake, send one frame, close. */
function speak(port: number, token: string, frame: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Already closing; the result is what matters.
      }
      resolve(ok);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS);

    const nonce = crypto.randomUUID();
    let authenticated = false;
    let challenged = false;
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'hello_v2', nonce }));
      } catch {
        done(false);
      }
    };
    ws.onerror = () => done(false);
    ws.onclose = () => done(false); // closed before we saw a welcome
    ws.onmessage = async (ev) => {
      if (settled) return;
      let msg: { type?: string; ok?: boolean; nonce?: string; proof?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // malformed frames are ignored, not fatal
      }
      if (msg.type === 'challenge_v2' && !challenged) {
        challenged = true;
        if (typeof msg.nonce !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(msg.nonce))
          return done(false);
        try {
          const expected = await bridgeProof(token, 'server', nonce, msg.nonce);
          if (settled || !equalProof(msg.proof, expected)) return done(false);
          const proof = await bridgeProof(token, 'client', nonce, msg.nonce);
          if (settled) return;
          authenticated = true;
          ws.send(JSON.stringify({ type: 'authenticate_v2', proof }));
        } catch {
          done(false);
        }
        return;
      }
      if (msg.type !== 'welcome_v2' || !authenticated) return done(false);
      if (!msg.ok) return done(false); // token refused
      try {
        ws.send(frame);
        done(true);
      } catch {
        done(false);
      }
    };
  });
}

/**
 * Send one frame to the agent, finding it if we have to.
 *
 * Tries the remembered port, then the range. The peer must prove possession of
 * the key before receiving any activity. Legacy plaintext-token peers fail closed.
 */
async function send(frame: string): Promise<boolean> {
  const token = await bridgeTokenItem.getValue();
  if (!token) return false; // not paired; nothing to say and no way to say it

  const cached = await pairedPortItem.getValue();
  if (cached !== null && (await speak(cached, token, frame))) return true;

  for (const port of BRIDGE_PORTS) {
    if (port === cached) continue; // just tried it
    if (await speak(port, token, frame)) {
      await pairedPortItem.setValue(port);
      siDebug('bridge', `paired on ${port}`);
      return true;
    }
  }
  // Forget a port that stopped answering, so the next report starts from the top
  // rather than retrying somewhere nothing is listening.
  if (cached !== null) await pairedPortItem.setValue(null);
  return false;
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
  return send(JSON.stringify(message));
}

/**
 * Tell the desktop we have dealt with this copy, so it doesn't raise its own
 * alert for the same one.
 *
 * Takes the hash as a decimal string, already computed by the content script
 * that saw the paste. Hashing there rather than here keeps the pasted text
 * inside the frame that produced it — it is never passed between extension
 * contexts, which is a boundary worth holding even in our own process.
 *
 * A string rather than a number because the u64 does not survive a round trip
 * through a JS number, and the frame is built by hand for the same reason.
 */
export function sendHandledHash(hashDecimal: string, ttlMs = HANDLED_TTL_MS): Promise<boolean> {
  if (!/^\d{1,20}$/.test(hashDecimal)) return Promise.resolve(false);
  return send(handledFrame(BigInt(hashDecimal), ttlMs));
}
