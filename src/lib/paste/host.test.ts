import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { PATTERNS } from '../detection/patterns';
import { installPasteWorkerHost } from './host';
import { createPasteComputation } from './process';
import {
  IDLE_TIMEOUT_MS,
  MAX_PASTE_SESSIONS,
  MAX_PASTE_WORKERS,
  PASTE_PORT,
  type PasteCommand,
  WORK_TIMEOUT_MS,
} from './protocol';

const scan = { id: 1, operation: 'scan', input: { text: 'safe', patterns: [], summary: false } };

function events() {
  const listeners = new Set<(...args: unknown[]) => void>();
  return {
    addListener: (fn: (...args: unknown[]) => void) => listeners.add(fn),
    removeListener: (fn: (...args: unknown[]) => void) => listeners.delete(fn),
    fire: (...args: unknown[]) => {
      for (const fn of [...listeners]) fn(...args);
    },
  };
}
function connection() {
  const port = {
    name: PASTE_PORT,
    sender: { id: fakeBrowser.runtime.id, tab: { id: 1 } },
    onMessage: events(),
    onDisconnect: events(),
    postMessage: vi.fn(),
    disconnect: vi.fn(() => port.onDisconnect.fire()),
  };
  return port;
}
function setup() {
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: undefined as Worker['onmessage'] | undefined,
    onerror: undefined as Worker['onerror'] | undefined,
    onmessageerror: undefined as Worker['onmessageerror'] | undefined,
  };
  const listen = vi
    .spyOn(fakeBrowser.runtime.onConnect, 'addListener')
    .mockImplementation(() => {});
  const makeWorker = vi.fn(() => worker as unknown as Worker);
  installPasteWorkerHost(makeWorker);
  const connect = listen.mock.calls.at(-1)![0];
  return {
    worker,
    makeWorker,
    connect: (port: ReturnType<typeof connection>) => connect(port as never),
  };
}
beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('terminates a stuck worker using a timer outside the worker', async () => {
  const { worker, connect } = setup();
  const port = connection();
  connect(port);
  port.onMessage.fire(scan);
  await vi.advanceTimersByTimeAsync(WORK_TIMEOUT_MS);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 1, ok: false }));
  expect(port.disconnect).toHaveBeenCalled();
});

test('disconnect cancels a running regex immediately and drops late replies', () => {
  const { worker, connect } = setup();
  const port = connection();
  connect(port);
  port.onMessage.fire(scan);
  port.onDisconnect.fire();
  worker.onmessage?.call(
    worker as unknown as Worker,
    new MessageEvent('message', { data: { id: 1, ok: true, result: [] } }),
  );
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(port.postMessage).not.toHaveBeenCalled();
});

test('idle paste data is discarded and capacity is bounded and released', async () => {
  const { worker, makeWorker, connect } = setup();
  for (let i = 0; i < MAX_PASTE_SESSIONS; i++) connect(connection());
  const overflow = connection();
  connect(overflow);
  expect(overflow.disconnect).toHaveBeenCalled();
  expect(makeWorker).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
  expect(worker.terminate).not.toHaveBeenCalled();
  const next = connection();
  connect(next);
  next.onMessage.fire(scan);
  expect(makeWorker).toHaveBeenCalledTimes(1);
});

test('rejects non-content-script senders before creating a worker', () => {
  const { makeWorker, connect } = setup();
  const port = connection();
  port.sender.id = 'different-extension';
  connect(port);
  expect(makeWorker).not.toHaveBeenCalled();
  expect(port.disconnect).toHaveBeenCalled();
});

test('memory overload refuses additional text without bypassing the scan', () => {
  const { connect } = setup();
  const ports = Array.from({ length: 10 }, () => {
    const port = connection();
    connect(port);
    port.onMessage.fire({ ...scan, input: { ...scan.input, text: 'x'.repeat(2_000_000) } });
    return port;
  });
  expect(ports[9].postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ ok: false, error: expect.stringContaining('capacity') }),
  );
  for (const port of ports) port.onDisconnect.fire();
});

test('disconnecting a queued session removes it without creating another worker', () => {
  const { connect, makeWorker } = setup();
  const ports = Array.from({ length: 5 }, () => {
    const port = connection();
    connect(port);
    port.onMessage.fire(scan);
    return port;
  });
  expect(makeWorker).toHaveBeenCalledTimes(4);
  ports[4].onDisconnect.fire();
  ports[0].onDisconnect.fire();
  expect(makeWorker).toHaveBeenCalledTimes(4);
  for (const port of ports) port.onDisconnect.fire();
});

test('successful replies reset the deadline without losing the session', async () => {
  const { worker, connect } = setup();
  const port = connection();
  connect(port);
  port.onMessage.fire(scan);
  worker.onmessage?.call(
    worker as unknown as Worker,
    new MessageEvent('message', { data: { id: 1, ok: true, result: [] } }),
  );
  await vi.advanceTimersByTimeAsync(WORK_TIMEOUT_MS + 1);
  expect(worker.terminate).not.toHaveBeenCalled();
  port.onMessage.fire({ id: 2, operation: 'sanitize', input: null });
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  port.onDisconnect.fire();
});

test('1,000 concurrent sessions complete real scans with at most four workers and isolated results', async () => {
  vi.useRealTimers();
  const listen = vi
    .spyOn(fakeBrowser.runtime.onConnect, 'addListener')
    .mockImplementation(() => {});
  let busy = 0;
  let peak = 0;
  const factory = vi.fn(() => {
    const worker = {
      onmessage: null as Worker['onmessage'],
      onerror: null,
      onmessageerror: null,
      terminate: vi.fn(),
      postMessage(command: PasteCommand) {
        busy++;
        peak = Math.max(peak, busy);
        queueMicrotask(() => {
          const result = createPasteComputation()(command);
          busy--;
          worker.onmessage?.call(
            worker as unknown as Worker,
            new MessageEvent('message', { data: { id: command.id, ok: true, result } }),
          );
        });
      },
    };
    return worker as unknown as Worker;
  });
  installPasteWorkerHost(factory);
  const connect = listen.mock.calls.at(-1)![0];
  const patterns = PATTERNS.map(({ regex, ...p }) => ({
    ...p,
    source: regex.source,
    flags: regex.flags,
  }));
  const ports = Array.from({ length: 1000 }, (_, i) => {
    const port = connection();
    port.sender.tab.id = i + 1;
    connect(port as never);
    port.onMessage.fire({
      id: 1,
      operation: 'scan',
      input: {
        text: `page ${i}: sk-${String(i).padStart(30, 'a')}`,
        patterns,
        summary: false,
      },
    });
    return port;
  });
  await vi.waitFor(
    () => expect(ports.every((port) => port.postMessage.mock.calls.length === 1)).toBe(true),
    { timeout: 10_000 },
  );
  for (let i = 0; i < ports.length; i++) {
    const response = ports[i].postMessage.mock.calls[0][0];
    expect(response.ok).toBe(true);
    expect(response.result.detections[0].match).toBe(`sk-${String(i).padStart(30, 'a')}`);
    ports[i].onDisconnect.fire();
  }
  expect(peak).toBeLessThanOrEqual(MAX_PASTE_WORKERS);
  expect(factory).toHaveBeenCalledTimes(MAX_PASTE_WORKERS);
}, 15_000);
