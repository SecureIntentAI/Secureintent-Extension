import { beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DEFAULT_TTL_MS } from '@/lib/vault';
import { handleVaultMessage, sweepVaults } from './vaultBackground';

beforeEach(() => {
  fakeBrowser.reset();
  vi.useRealTimers();
});
const put = (n: number, url = 'https://chatgpt.com/chat') =>
  handleVaultMessage(
    {
      type: 'si-vault-put',
      entries: [{ token: `⟦SI:${n.toString(16).padStart(8, '0')}⟧`, secret: `secret-${n}` }],
    },
    url,
  );
test('concurrent tab writes preserve every origin-bound mapping', async () => {
  await Promise.all(Array.from({ length: 100 }, (_, i) => put(i)));
  const result = await handleVaultMessage(
    { type: 'si-vault-read' },
    'https://chatgpt.com/elsewhere',
  );
  expect(Object.keys(result.entries ?? {})).toHaveLength(100);
  expect(
    (await handleVaultMessage({ type: 'si-vault-read' }, 'https://claude.ai/')).entries,
  ).toEqual({});
});
test('expiration sweep physically removes old values from session storage', async () => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await put(1);
  vi.spyOn(Date, 'now').mockReturnValue(now + DEFAULT_TTL_MS + 1);
  await sweepVaults();
  expect(JSON.stringify(await fakeBrowser.storage.session.get(null))).not.toContain('secret-1');
  expect(
    (await handleVaultMessage({ type: 'si-vault-read' }, 'https://chatgpt.com/')).entries,
  ).toEqual({});
  vi.restoreAllMocks();
});
test('rejects non-web origins and malformed token mappings', async () => {
  await expect(put(1, 'file:///tmp/anything')).rejects.toThrow();
  await expect(
    handleVaultMessage(
      { type: 'si-vault-put', entries: [{ token: '__proto__', secret: 'x' }] },
      'https://chatgpt.com/',
    ),
  ).rejects.toThrow();
});
