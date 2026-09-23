import { expect, test } from './fixtures';
import { PATTERNS } from '../src/lib/detection/patterns';

test('1,000 runtime sessions complete in the real Chromium worker host', async ({ context, extensionId }) => {
  test.setTimeout(90_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const patterns = PATTERNS.map(({ regex, ...pattern }) => ({ ...pattern, source: regex.source, flags: regex.flags }));
  const results = await page.evaluate(async (patterns) => {
    const runtime = (globalThis as unknown as { chrome: { runtime: {
      sendMessage(message: unknown): Promise<{ ok: boolean }>;
      connect(options: { name: string }): {
        postMessage(message: unknown): void; disconnect(): void;
        onMessage: { addListener(fn: (reply: { ok: boolean; result?: { total: number; handledHash: string }; error?: string }) => void): void };
        onDisconnect: { addListener(fn: () => void): void };
      };
    } } }).chrome.runtime;
    const ready = await runtime.sendMessage({ type: 'si-paste-worker-ready' });
    if (!ready.ok) throw new Error('Worker host unavailable');
    const start = performance.now();
    let beats = 0;
    const heartbeat = setInterval(() => beats++, 10);
    const latency: number[] = [];
    const output = await Promise.all(Array.from({ length: 1000 }, (_, i) => new Promise<{ ok: boolean; total?: number; error?: string }>((resolve) => {
      const port = runtime.connect({ name: 'si-paste-worker' });
      let complete = false;
      const done = (value: { ok: boolean; total?: number; error?: string }) => {
        if (complete) return; complete = true; clearTimeout(timer);
        latency.push(performance.now() - start); resolve(value); port.disconnect();
      };
      const timer = setTimeout(() => done({ ok: false, error: 'test deadline' }), 40_000);
      port.onMessage.addListener((r) => done({ ok: r.ok, total: r.result?.total, error: r.error }));
      port.onDisconnect.addListener(() => done({ ok: false, error: 'disconnected' }));
      port.postMessage({ id: 1, operation: 'scan', input: {
        text: `page ${i}: sk-${String(i).padStart(30, 'a')}`,
        patterns, summary: false,
      } });
    })));
    clearInterval(heartbeat); latency.sort((a, b) => a - b);
    return { completed: output.filter((r) => r.ok && r.total === 1).length,
      failures: output.filter((r) => !r.ok).slice(0, 10), elapsedMs: performance.now() - start,
      p95Ms: latency[949], beats };
  }, patterns);
  await test.info().attach('load-metrics.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  console.log('1000-session worker metrics:', JSON.stringify(results));
  expect(results.failures).toEqual([]);
  expect(results.completed).toBe(1000);
  expect(results.beats).toBeGreaterThan(0);
  await page.close();
});
