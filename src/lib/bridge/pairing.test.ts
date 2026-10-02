import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { bridgeAvailableItem, forgetManualPairing } from '@/settings';
import { MISS_BACKOFF_MS, NATIVE_HOST, pairingToken } from './pairing';

const TOKEN = '3f2b8c1e-9a4d-4e7b-b6c2-5d8e1f0a7c93';
let reply: unknown = { type: 'pairing', v: 1, token: TOKEN };
let calls = 0;

beforeEach(() => {
  fakeBrowser.reset();
  vi.useRealTimers();
  reply = { type: 'pairing', v: 1, token: TOKEN };
  calls = 0;
  fakeBrowser.runtime.sendNativeMessage = vi.fn(async (name: string) => {
    calls++;
    if (name !== NATIVE_HOST || reply === 'missing') throw new Error('host not found');
    return reply;
  }) as unknown as typeof fakeBrowser.runtime.sendNativeMessage;
});

describe('pairingToken', () => {
  test('asks the desktop once per session and remembers the answer', async () => {
    expect(await pairingToken()).toBe(TOKEN);
    expect(await pairingToken()).toBe(TOKEN);
    expect(calls).toBe(1);
    expect(await bridgeAvailableItem.getValue()).toBe(true);
  });

  test('the token lives in session storage only, never on disk', async () => {
    await pairingToken();
    expect(await fakeBrowser.storage.local.get(null)).not.toHaveProperty('si_bridge_token');
    expect(JSON.stringify(await fakeBrowser.storage.local.get(null))).not.toContain(TOKEN);
    expect(await fakeBrowser.storage.session.get('si_bridge_token')).toEqual({
      si_bridge_token: TOKEN,
    });
  });

  test('no desktop app: null, marked unavailable, and not asked again for a while', async () => {
    reply = 'missing';
    expect(await pairingToken()).toBeNull();
    expect(await bridgeAvailableItem.getValue()).toBe(false);
    expect(await pairingToken()).toBeNull();
    expect(calls).toBe(1);

    vi.useFakeTimers({ now: Date.now() + MISS_BACKOFF_MS + 1 });
    reply = { type: 'pairing', v: 1, token: TOKEN };
    expect(await pairingToken()).toBe(TOKEN);
    expect(calls).toBe(2);
  });

  test('fresh skips the cache, so a reinstalled desktop is picked up', async () => {
    await pairingToken();
    reply = { type: 'pairing', v: 1, token: 'a-brand-new-token-000000' };
    expect(await pairingToken({ fresh: true })).toBe('a-brand-new-token-000000');
  });

  test('a reply that is not a plausible token is not used', async () => {
    for (const bad of [
      { type: 'pairing', token: null },
      { type: 'pairing', token: 'short' },
      { type: 'pairing', token: 'has spaces in it but is long' },
      { type: 'error', token: TOKEN },
      null,
      'nonsense',
    ]) {
      reply = bad;
      expect(await pairingToken({ fresh: true })).toBeNull();
    }
    expect(await bridgeAvailableItem.getValue()).toBe(false);
  });
});

describe('forgetManualPairing', () => {
  test('removes the switch and the pasted token older versions stored', async () => {
    await fakeBrowser.storage.local.set({
      si_bridge_enabled: true,
      si_bridge_token: 'pasted-by-hand-000000',
      si_enabled: true,
    });
    await forgetManualPairing();
    const left = await fakeBrowser.storage.local.get(null);
    expect(left).not.toHaveProperty('si_bridge_enabled');
    expect(left).not.toHaveProperty('si_bridge_token');
    expect(left).toHaveProperty('si_enabled', true);
  });
});
