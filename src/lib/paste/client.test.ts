import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { createPasteProcessor } from './client';
import { PASTE_READY, PASTE_REQUEST_TIMEOUT_MS, type PasteReply } from './protocol';

function setup() {
  let onReply: ((reply: PasteReply) => void) | undefined;
  let onDisconnect: (() => void) | undefined;
  const port = {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (fn: (reply: PasteReply) => void) => {
        onReply = fn;
      },
      removeListener: () => {
        onReply = undefined;
      },
    },
    onDisconnect: {
      addListener: (fn: () => void) => {
        onDisconnect = fn;
      },
      removeListener: () => {
        onDisconnect = undefined;
      },
    },
  };
  const ready = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true });
  const connect = vi.spyOn(fakeBrowser.runtime, 'connect').mockReturnValue(port as never);
  const controller = new AbortController();
  return {
    port,
    ready,
    connect,
    controller,
    reply: (reply: PasteReply) => onReply?.(reply),
    disconnect: () => onDisconnect?.(),
    start: () => createPasteProcessor(controller.signal),
  };
}
beforeEach(() => {
  fakeBrowser.reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('sets up the host without clipboard data and uses a private request/reply port', async () => {
  const t = setup();
  const client = await t.start();
  expect(t.ready).toHaveBeenCalledExactlyOnceWith({ type: PASTE_READY });
  const work = client.request('sanitize', null);
  expect(t.port.postMessage).toHaveBeenCalledWith({ id: 1, operation: 'sanitize', input: null });
  t.reply({ id: 1, ok: true, result: 'safe text' });
  expect(await work).toBe('safe text');
  t.controller.abort();
  expect(t.port.disconnect).toHaveBeenCalledTimes(1);
});

test('cancellation rejects immediately and drops late replies', async () => {
  const t = setup();
  const client = await t.start();
  const work = client.request('sanitize', null);
  const assertion = expect(work).rejects.toThrow();
  t.controller.abort();
  t.reply({ id: 1, ok: true, result: 'must not insert' });
  await assertion;
  expect(t.port.disconnect).toHaveBeenCalledTimes(1);
});

test('a dropped host has a backup deadline and closes the port', async () => {
  vi.useFakeTimers();
  const t = setup();
  const client = await t.start();
  const work = client.request('sanitize', null);
  const assertion = expect(work).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(PASTE_REQUEST_TIMEOUT_MS);
  await assertion;
  expect(t.port.disconnect).toHaveBeenCalledTimes(1);
});

test('host failure is fail-closed, never a main-thread processing fallback', async () => {
  const t = setup();
  t.ready.mockResolvedValue({ ok: false });
  await expect(t.start()).rejects.toThrow('unavailable');
  expect(t.connect).not.toHaveBeenCalled();
});

test('navigation or idle expiry rejects the active request', async () => {
  const t = setup();
  const client = await t.start();
  const work = client.request('sanitize', null);
  const assertion = expect(work).rejects.toThrow();
  t.disconnect();
  await assertion;
});

test('cancellation during host creation cannot open a late port', async () => {
  const t = setup();
  let finish!: (value: { ok: boolean }) => void;
  t.ready.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const start = t.start();
  const assertion = expect(start).rejects.toThrow();
  t.controller.abort();
  finish({ ok: true });
  await assertion;
  expect(t.connect).not.toHaveBeenCalled();
});
