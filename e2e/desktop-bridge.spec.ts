import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from '@playwright/test';
import { test } from './fixtures';

// Live: the real extension in Chromium against a running SecureIntent desktop
// agent that has registered its native messaging host. Not part of `pnpm e2e`.
//   SI_DESKTOP_E2E=1 pnpm e2e:desktop
// Optional: SI_HANDLED_VALUE=<fake key> reports that value as handled; with
// SI_COPY_LOG=<file> it is also copied at once, so a harness can check the agent
// stayed quiet about it.

declare const chrome: {
  runtime: {
    sendNativeMessage(host: string, message: unknown): Promise<unknown>;
    sendMessage(message: unknown): Promise<unknown>;
  };
  storage: {
    local: { get(keys: string | null): Promise<Record<string, unknown>> };
    session: { get(keys: string | null): Promise<Record<string, unknown>> };
  };
};

test.skip(!process.env.SI_DESKTOP_E2E, 'needs a running SecureIntent desktop agent');

async function worker(context: import('@playwright/test').BrowserContext) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return sw;
}

test('pairs with the desktop app with nothing typed in', async ({ context }) => {
  const sw = await worker(context);

  // The browser starts the host the agent registered, for this extension id only.
  const reply = (await sw.evaluate(() =>
    chrome.runtime.sendNativeMessage('ai.secureintent.desktop', { type: 'get_pairing', v: 1 }),
  )) as { type: string; token: unknown; enabled: boolean; ports: number[] };
  expect(reply.type).toBe('pairing');
  expect(reply.enabled).toBe(true);
  expect(typeof reply.token).toBe('string');
  expect(reply.ports).toEqual([8137, 8138, 8139, 8140, 8141]);

  // The background paired on install, on its own.
  await expect
    .poll(() => sw.evaluate(async () => (await chrome.storage.local.get('si_bridge_available')).si_bridge_available))
    .toBe(true);
  const session = await sw.evaluate(() => chrome.storage.session.get('si_bridge_token'));
  expect(session.si_bridge_token).toBe(reply.token);
  // Never on disk.
  const local = await sw.evaluate(() => chrome.storage.local.get(null));
  expect(JSON.stringify(local)).not.toContain(reply.token as string);
});

test('a paste the extension handled is not flagged again by the agent', async ({ context }) => {
  const value = process.env.SI_HANDLED_VALUE;
  test.skip(!value, 'set SI_HANDLED_VALUE to run');
  const sw = await worker(context);
  const digest = await sw.evaluate(async (v) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, value as string);
  // What the paste guard sends after a warning; the background keys it and tells the agent.
  const page = await context.newPage();
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.evaluate((d) => chrome.runtime.sendMessage({ type: 'si-bridge-handled', digest: d }), digest);
  await page.waitForTimeout(700);
  const reported = Date.now();
  // Copying needs an unlocked desktop; a harness without one checks the agent's
  // side of the report instead.
  if (!process.env.SI_COPY_LOG) return;
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `for ($i = 0; $i -lt 30; $i++) { try { Set-Clipboard -Value '${value}' -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 100 } }`,
  ]);
  writeFileSync(process.env.SI_COPY_LOG, JSON.stringify({ reported, copied: Date.now() }));
});

// Last: with a browser in front, a reported localhost tab lets copies through
// for 10 s (the desktop's localhost rule), which would mask the handled check.
test('a focused localhost tab reaches the agent', async ({ context }) => {
  const server = createServer((_, res) => res.end('<!doctype html><title>dev</title><p>dev server</p>'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/`);
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    // The harness checks the agent's "last connected" moved; give the debounced
    // report time to go out.
    await page.waitForTimeout(1500);
    writeFileSync(process.env.SI_URL_LOG ?? 'desktop-url.json', JSON.stringify({ port, at: Date.now() }));
  } finally {
    server.close();
  }
});
