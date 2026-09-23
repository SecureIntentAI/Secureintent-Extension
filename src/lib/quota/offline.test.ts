import { beforeEach, describe, expect, test } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { OFFLINE_LIMIT, offlineConsume, offlineUsed } from './offline';

beforeEach(() => fakeBrowser.reset());

describe('offline anonymise quota', () => {
  test('concurrent requests never spend more than the allowance', async () => {
    const results = await Promise.all(Array.from({ length: 1000 }, () => offlineConsume()));
    expect(results.filter((r) => r.allowed)).toHaveLength(OFFLINE_LIMIT);
    expect(await offlineUsed()).toBe(OFFLINE_LIMIT);
  });
  test('starts at zero used', async () => {
    expect(await offlineUsed()).toBe(0);
  });

  test('consumes up to the limit, then blocks', async () => {
    for (let i = 1; i <= OFFLINE_LIMIT; i++) {
      const r = await offlineConsume();
      expect(r.allowed).toBe(true);
      expect(r.used).toBe(i);
    }
    expect(await offlineUsed()).toBe(OFFLINE_LIMIT);
    const over = await offlineConsume();
    expect(over).toEqual({ used: OFFLINE_LIMIT, allowed: false });
  });

  test('persists the count across reads (round-trips through storage)', async () => {
    await offlineConsume();
    await offlineConsume();
    expect(await offlineUsed()).toBe(2);
  });

  test('the stored value is obfuscated — not a readable count', async () => {
    await offlineConsume();
    await offlineConsume();
    await offlineConsume();
    const raw = JSON.stringify(await fakeBrowser.storage.local.get('si_rhythm'));
    expect(raw).toContain('pulse'); // innocuous field name, not "count"/"used"
    expect(raw).not.toContain('3'); // the count "3" never appears in the clear
    expect(raw).not.toMatch(/\d{4}-\d{2}/); // nor the YYYY-MM month
  });
});
