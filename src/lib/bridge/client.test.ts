import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { bridgeTokenItem } from '@/settings';
import { bridgeProof } from './auth';
import { sendBrowserUrl, sendHandledHash } from './client';

const TOKEN = 'pairing-token';

/**
 * A WebSocket stand-in driven by a per-port script, so a test can say "8137 is
 * squatted, 8139 is the agent" and check we end up on 8139. It also checks the
 * token, because refusing a bad one is behaviour we depend on.
 */
type Behaviour = 'agent' | 'dead' | 'squatter';
let behaviour: Record<number, Behaviour> = {};
let opened: number[] = [];
let sent: Array<{ port: number; raw: string }> = [];

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
    if (raw.includes(TOKEN)) throw new Error('Pairing key disclosed');
    if (frame.type === 'hello_v2') {
      this.nonce = frame.nonce;
      if (behaviour[this.port] === 'squatter') {
        this.onmessage?.({ data: JSON.stringify({ type: 'welcome', ok: true }) });
        return;
      }
      const proof = await bridgeProof(TOKEN, 'server', this.nonce, this.serverNonce);
      this.onmessage?.({
        data: JSON.stringify({ type: 'challenge_v2', nonce: this.serverNonce, proof }),
      });
      return;
    }
    if (frame.type === 'authenticate_v2') {
      const ok = frame.proof === (await bridgeProof(TOKEN, 'client', this.nonce, this.serverNonce));
      this.onmessage?.({ data: JSON.stringify({ type: 'welcome_v2', ok }) });
      return;
    }
    sent.push({ port: this.port, raw });
  }

  close() {}
}

beforeEach(async () => {
  fakeBrowser.reset();
  behaviour = {};
  opened = [];
  sent = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  await bridgeTokenItem.setValue(TOKEN);
});

describe('pairing', () => {
  test('a port squatter receives neither the token nor activity', async () => {
    behaviour = { 8137: 'squatter', 8138: 'agent' };
    expect(await sendBrowserUrl('localhost', 3000)).toBe(true);
    expect(sent.map((s) => s.port)).toEqual([8138]);
  });
  test('says nothing at all until a token is saved', async () => {
    await bridgeTokenItem.setValue(null);
    behaviour = { 8137: 'agent' };
    expect(await sendBrowserUrl('localhost', 3000)).toBe(false);
    // Not merely unsent — no socket is opened, so an unpaired browser never
    // touches a local port.
    expect(opened).toEqual([]);
  });

  test('a token the agent rejects sends nothing', async () => {
    await bridgeTokenItem.setValue('wrong');
    behaviour = { 8137: 'agent' };
    expect(await sendBrowserUrl('localhost', 3000)).toBe(false);
    expect(sent).toEqual([]);
  });

  test('walks past a dead port to the agent behind it', async () => {
    behaviour = { 8139: 'agent' };
    expect(await sendBrowserUrl('localhost', 5173)).toBe(true);
    expect(opened).toEqual([8137, 8138, 8139]);
    expect(sent.map((s) => s.port)).toEqual([8139]);
  });

  test('no agent at all is a quiet false, not a throw', async () => {
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

  test('the u64 reaches the wire exactly, not rounded through a JS number', async () => {
    // 16654208175385433931 is contentHash('abc'). Through Number it becomes
    // ...434000, the desktop looks up a hash we never sent, and every dedup
    // misses in silence. This is the assertion that catches that.
    await sendHandledHash('16654208175385433931');
    expect(sent[0].raw).toContain('"hash":16654208175385433931');
    expect(sent[0].raw).not.toContain('16654208175385434000');
  });

  test('carries a ttl the desktop can honour', async () => {
    await sendHandledHash('123');
    expect(JSON.parse(sent[0].raw)).toEqual({ type: 'handled', hash: 123, ttl_ms: 5000 });
  });

  test('anything that is not a plain decimal is refused', async () => {
    for (const bad of ['', 'abc', '1e5', '-1', '12.5', '1; DROP TABLE']) {
      expect(await sendHandledHash(bad)).toBe(false);
    }
    expect(sent).toEqual([]);
  });
});
