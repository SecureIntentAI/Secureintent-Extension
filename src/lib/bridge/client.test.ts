import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { bridgeProof } from './auth';
import { sendBrowserUrl, sendHandled } from './client';
import { contentDigest, dedupMac } from './hash';
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
  }

  close() {}
}

/** What the desktop's native host says. `null` host: no desktop app installed. */
let host: { token: string | null } | null = { token: TOKEN };
const nativeCalls: unknown[] = [];

beforeEach(async () => {
  fakeBrowser.reset();
  behaviour = {};
  opened = [];
  sent = [];
  agentToken = TOKEN;
  host = { token: TOKEN };
  nativeCalls.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  fakeBrowser.runtime.sendNativeMessage = vi.fn(async (name: string, message: unknown) => {
    nativeCalls.push(message);
    if (name !== NATIVE_HOST || host === null) {
      throw new Error('Specified native messaging host not found.');
    }
    return { type: 'pairing', v: 1, token: host.token, ports: [8137, 8138, 8139, 8140, 8141] };
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
