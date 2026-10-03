import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { browser } from '#imports';
import { injectOpenTabs } from './injectOpenTabs';

const scripting = browser.scripting;
const setScripting = (value: unknown) =>
  Object.defineProperty(browser, 'scripting', {
    configurable: true,
    value,
    writable: true,
  });

beforeEach(() => {
  fakeBrowser.reset();
  setScripting(scripting);
  vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([
    { id: 1, url: 'https://chatgpt.com/c/example' },
  ] as Awaited<ReturnType<typeof fakeBrowser.tabs.query>>);
});
afterEach(() => {
  vi.restoreAllMocks();
  setScripting(scripting);
});

test('Chrome injects the ordered files in one scripting call', async () => {
  const modern = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([]);
  const legacy = vi.spyOn(fakeBrowser.tabs, 'executeScript').mockResolvedValue([]);
  await injectOpenTabs();
  expect(modern).toHaveBeenCalledWith({
    target: { tabId: 1 },
    files: [
      'content-scripts/chatgpt.js',
      'content-scripts/fallback.js',
      'content-scripts/bridge.js',
    ],
  });
  expect(legacy).not.toHaveBeenCalled();
});

test('Firefox waits for its dedicated guard before injecting fallback and bridge scripts', async () => {
  setScripting(undefined);
  let release!: (value: unknown[]) => void;
  const legacy = vi
    .spyOn(fakeBrowser.tabs, 'executeScript')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue([]);
  const injection = injectOpenTabs();
  await vi.waitFor(() => expect(legacy).toHaveBeenCalledTimes(1));
  expect(legacy).toHaveBeenCalledWith(1, { file: '/content-scripts/chatgpt.js' });
  release([]);
  await injection;
  expect(legacy.mock.calls).toEqual([
    [1, { file: '/content-scripts/chatgpt.js' }],
    [1, { file: '/content-scripts/fallback.js' }],
    [1, { file: '/content-scripts/bridge.js' }],
  ]);
});

test('one denied Firefox tab does not stop other tabs and browser pages are skipped', async () => {
  setScripting(undefined);
  vi.mocked(fakeBrowser.tabs.query).mockResolvedValue([
    { id: 1, url: 'https://chatgpt.com/' },
    { id: 2, url: 'https://example.com/' },
    { id: 3, url: 'about:addons' },
    { id: 4 },
  ] as Awaited<ReturnType<typeof fakeBrowser.tabs.query>>);
  const legacy = vi
    .spyOn(fakeBrowser.tabs, 'executeScript')
    .mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 1) throw new Error('Permission denied');
      return [];
    });
  await injectOpenTabs();
  expect(legacy.mock.calls).toEqual([
    [1, { file: '/content-scripts/chatgpt.js' }],
    [2, { file: '/content-scripts/fallback.js' }],
    [2, { file: '/content-scripts/bridge.js' }],
  ]);
});
