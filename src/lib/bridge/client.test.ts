import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { bridgeProof } from './auth';
import { desktopConnected, queryAllowed, sendBrowserUrl, sendHandled } from './client';
import { allowedMac, contentDigest, dedupMac } from './hash';
import { NATIVE_HOST } from './pairing';

const TOKEN = 'pairing-token-0123456789';

/**
 * A WebSocket stand-in driven by a per-port script, so a test can say "8137 is
 * squatted, 8139 is the agent" and check we end up on 8139. It checks the proofs
 * against `agentToken`, the token the agent currently holds, because refusing a
 * bad one is behaviour we depend on.
 */
type Behaviour = 'agent' | 'dead' | 'squatter';
let behaviour: Record<number, Behaviour> = {};
let opened: number[] = [];
let sent: Array<{ port: number; raw: string }> = [];
let agentToken = TOKEN;
/** MACs the agent answers "allowed" for, and whether it answers the question at all. */
let allowedMacs = new Set<string>();
let agentAnswersQueries = true;

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private port: number;
  private nonce = '';
  private serverNonce = 'server-random-nonce-123456789';

  constructor(url: string) {
    this.port = Number(new URL(url).port);
    opened.push(this.port);
    queueMicrotask(() => {
      if ((behaviour[this.port] ?? 'dead') === 'dead') return this.onclose?.();
      this.onopen?.();
    });
  }

  async send(raw: string) {
    const frame = JSON.parse(raw);
    if (raw.includes(agentToken) || raw.includes(TOKEN)) throw new Error('Pairing key disclosed');
    if (frame.type === 'hello_v2') {
      this.nonce = frame.nonce;
      if (behaviour[this.port] === 'squatter') {
        this.onmessage?.({ data: JSON.stringify({ type: 'welcome', ok: true }) });
        return;
      }
      const proof = await bridgeProof(agentToken, 'server', this.nonce, this.serverNonce);
      this.onmessage?.({
        data: JSON.stringify({ type: 'challenge_v2', nonce: this.serverNonce, proof }),
      });
      return;
    }
    if (frame.type === 'authenticate_v2') {
      const ok =
        frame.proof === (await bridgeProof(agentToken, 'client', this.nonce, this.serverNonce));
      this.onmessage?.({ data: JSON.stringify({ type: 'welcome_v2', ok }) });
      return;
    }
    sent.push({ port: this.port, raw });
    if (frame.type === 'query_allowed' && agentAnswersQueries) {
      this.onmessage?.({
        data: JSON.stringify({ type: 'allowed', ok: allowedMacs.has(frame.mac) }),
      });
    }
  }

  close() {}
}

/** What the desktop's native host says. `null` host: no desktop app installed. */
let host: { token: string | null; undoSync?: boolean } | null = { token: TOKEN };
const nativeCalls: unknown[] = [];

beforeEach(async () => {
  fakeBrowser.reset();
  behaviour = {};
  opened = [];
  sent = [];
  agentToken = TOKEN;
  allowedMacs = new Set();
  agentAnswersQueries = true;
  host = { token: TOKEN, undoSync: true };
  nativeCalls.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  fakeBrowser.runtime.sendNativeMessage = vi.fn(async (name: string, message: unknown) => {
    nativeCalls.push(message);
    if (name !== NATIVE_HOST || host === null) {
      throw new Error('Specified native messaging host not found.');
    }
    return {
      type: 'pairing',
      v: 1,
      token: host.token,
      ports: [8137, 8138, 8139, 8140, 8141],
      ...(host.undoSync ? { undo_sync: true } : {}),
    };
  }) as unknown as typeof fakeBrowser.runtime.sendNativeMessage;
});

describe('pairing', () => {
  test('pairs using the token the desktop app hands over, with nothing typed in', async () => {
    behaviour = { 8137: 'agent' };
    expect(await sendBrowserUrl('localhost', 3000)).toBe(true);
    expect(nativeCalls).toEqual([{ type: 'get_pairing', v: 1 }]);
  });

  test('a port squatter receives neither the token nor activity', async () => {
    behaviour = { 8137: 'squatter', 8138: 'agent' };
    expect(await sendBrowserUrl('localhost', 3000)).toBe(true);
    expect(sent.map((s) => s.port)).toEqual([8138]);
  });

  test('with no desktop app, no local port is ever opened', async () => {
    host = null;
    behaviour = { 8137: 'agent' };
    expect(await sendBrowserUrl('localhost', 3000)).toBe(false);
    // Not merely unsent — no socket is opened, so a browser without the desktop
    // app never touches a local port.
    expect(opened).toEqual([]);
  });

  test('a desktop app that has never run (no token yet) is treated the same', async () => {
    host = { token: null };
    behaviour = { 8137: 'agent' };
    expect(await sendBrowserUrl('localhost', 3000)).toBe(false);
    expect(opened).toEqual([]);
  });

  test('a missing desktop app is not asked again on every report', async () => {
    host = null;
    await sendBrowserUrl('localhost', 3000);
    await sendBrowserUrl('localhost', 3001);
    await sendHandled(await contentDigest('x'));
    expect(nativeCalls).toHaveLength(1);
  });

  test('a token the agent no longer accepts is refreshed from the desktop once', async () => {
    behaviour = { 8137: 'agent' };
    expect(await sendBrowserUrl('localhost', 3000)).toBe(true);
    // Reinstalled: the agent and its host now hold a new token.
    agentToken = 'reinstalled-token-9876543210';
    host = { token: agentToken };
    expect(await sendBrowserUrl('localhost', 4000)).toBe(true);
    expect(nativeCalls).toHaveLength(2);
    expect(sent.at(-1)?.raw).toContain('localhost:4000');
  });

  test('a refused token that the desktop still hands out is not retried forever', async () => {
    behaviour = { 8137: 'agent' };
    agentToken = 'something-else-entirely-000';
    expect(await sendBrowserUrl('localhost', 3000)).toBe(false);
    expect(sent).toEqual([]);
    expect(nativeCalls).toHaveLength(2); // the first lookup, then one refresh
  });

  test('walks past a dead port to the agent behind it', async () => {
    behaviour = { 8139: 'agent' };
    expect(await sendBrowserUrl('localhost', 5173)).toBe(true);
    expect(opened).toEqual([8137, 8138, 8139]);
    expect(sent.map((s) => s.port)).toEqual([8139]);
  });

  test('no agent running is a quiet false, not a throw', async () => {
    await expect(sendBrowserUrl('localhost', 3000)).resolves.toBe(false);
  });

  test('the next report goes straight to the known port', async () => {
    behaviour = { 8138: 'agent' };
    await sendBrowserUrl('localhost', 3000);
    opened = [];
    await sendBrowserUrl('localhost', 4000);
    expect(opened).toEqual([8138]);
  });

  test('an agent that moved ports is found again', async () => {
    behaviour = { 8137: 'agent' };
    await sendBrowserUrl('localhost', 3000);
    behaviour = { 8140: 'agent' };
    expect(await sendBrowserUrl('localhost', 3000)).toBe(true);
    expect(sent.at(-1)?.port).toBe(8140);
  });
});

describe('browser_url', () => {
  beforeEach(() => {
    behaviour = { 8137: 'agent' };
  });

  test('carries a url the desktop can deserialise, plus host and port', async () => {
    await sendBrowserUrl('localhost', 3000);
    const frame = JSON.parse(sent[0].raw);
    // `url` is the field their BrowserUrl variant requires; a frame without it
    // fails to parse on their side and is dropped without a word.
    expect(frame).toEqual({
      type: 'browser_url',
      url: 'http://localhost:3000',
      host: 'localhost',
      port: 3000,
      ts: expect.any(Number),
    });
  });

  test('the url is an origin — never a path, query or fragment', async () => {
    await sendBrowserUrl('app.internal', 8443, 'https');
    const { url } = JSON.parse(sent[0].raw);
    expect(url).toBe('https://app.internal:8443');
    expect(url).not.toContain('?');
    expect(url).not.toContain('#');
    // The privacy case for this feature rests on that. A query string on a dev
    // URL routinely carries a session token.
    expect(new URL(url).pathname).toBe('/');
  });

  test('a port-less host omits the port rather than inventing one', async () => {
    await sendBrowserUrl('chatgpt.com', null, 'https');
    const frame = JSON.parse(sent[0].raw);
    expect(frame.url).toBe('https://chatgpt.com');
    expect(frame.port).toBeNull();
  });
});

describe('handled', () => {
  beforeEach(() => {
    behaviour = { 8137: 'agent' };
  });

  test('sends the token-keyed MAC, never the digest or the value', async () => {
    const digest = await contentDigest('AKIAIOSFODNN7EXAMPLE');
    expect(await sendHandled(digest)).toBe(true);
    const frame = JSON.parse(sent[0].raw);
    expect(frame).toEqual({ type: 'handled', mac: await dedupMac(TOKEN, digest), ttl_ms: 5000 });
    expect(sent[0].raw).not.toContain(digest);
    expect(sent[0].raw).not.toContain('AKIA');
    expect(frame).not.toHaveProperty('hash');
  });

  test('after a token refresh the MAC is keyed with the new token', async () => {
    const digest = await contentDigest('AKIAIOSFODNN7EXAMPLE');
    await sendBrowserUrl('localhost', 1); // pairs with TOKEN, which is now cached
    agentToken = 'reinstalled-token-9876543210';
    host = { token: agentToken };
    expect(await sendHandled(digest)).toBe(true);
    expect(JSON.parse(sent.at(-1)?.raw ?? '{}').mac).toBe(await dedupMac(agentToken, digest));
  });

  test('anything that is not a 64-char lowercase hex digest is refused', async () => {
    for (const bad of ['', 'abc', '16654208175385433931', 'Z'.repeat(64), `${'a'.repeat(63)}`]) {
      expect(await sendHandled(bad)).toBe(false);
    }
    expect(sent).toEqual([]);
  });
});

describe('queryAllowed', () => {
  const digestOf = () => contentDigest('AKIAIOSFODNN7EXAMPLE');

  beforeEach(async () => {
    behaviour = { 8137: 'agent' };
    await sendBrowserUrl('localhost', 3000); // paired, so the port is known
    sent = [];
    opened = [];
  });

  test('yes only for text the desktop says was restored with Undo', async () => {
    const digest = await digestOf();
    expect(await queryAllowed(digest)).toBe(false);
    allowedMacs.add(await allowedMac(TOKEN, digest));
    expect(await queryAllowed(digest)).toBe(true);
    expect(await queryAllowed(await contentDigest('something else'))).toBe(false);
  });

  test('asks with the keyed MAC, never the digest or the value', async () => {
    const digest = await digestOf();
    await queryAllowed(digest);
    expect(JSON.parse(sent[0].raw)).toEqual({
      type: 'query_allowed',
      mac: await allowedMac(TOKEN, digest),
    });
    expect(sent[0].raw).not.toContain(digest);
    expect(sent[0].raw).not.toContain('AKIA');
  });

  test('a desktop app that cannot be asked is not asked, so the paste does not wait', async () => {
    host = { token: TOKEN }; // an older desktop: no undo_sync in its reply
    fakeBrowser.reset();
    await sendBrowserUrl('localhost', 3000);
    sent = [];
    opened = [];
    expect(await queryAllowed(await digestOf())).toBe(false);
    expect(opened).toEqual([]);
  });

  test('no answer in time is a no', async () => {
    agentAnswersQueries = false;
    const started = Date.now();
    expect(await queryAllowed(await digestOf())).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('only the port already paired on is tried', async () => {
    behaviour = { 8137: 'dead', 8138: 'agent' };
    expect(await queryAllowed(await digestOf())).toBe(false);
    expect(opened).toEqual([8137]);
  });

  test('a malformed digest is refused without opening anything', async () => {
    expect(await queryAllowed('not-a-digest')).toBe(false);
    expect(opened).toEqual([]);
  });
});

describe('desktopConnected', () => {
  test('true when the desktop app answers the handshake', async () => {
    behaviour = { 8137: 'agent' };
    expect(await desktopConnected()).toBe(true);
  });

  test('false when the app is installed but not running', async () => {
    behaviour = {};
    expect(await desktopConnected()).toBe(false);
  });

  test('false, with no port opened, when there is no desktop app or it is switched off', async () => {
    behaviour = { 8137: 'agent' };
    host = null;
    expect(await desktopConnected()).toBe(false);
    host = { token: null }; // switched off in the desktop app: it hands over no token
    expect(await desktopConnected()).toBe(false);
    expect(opened).toEqual([]);
  });

  test('asks the desktop afresh each time, so switching it off shows at once', async () => {
    behaviour = { 8137: 'agent' };
    expect(await desktopConnected()).toBe(true);
    host = { token: null };
    expect(await desktopConnected()).toBe(false);
  });
});
