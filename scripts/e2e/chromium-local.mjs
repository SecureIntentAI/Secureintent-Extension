// Chromium counterpart to the Firefox harness. Clerk itself is replaced only
// in the isolated test build; entitlement, policy verification and guards run.
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

export async function launchFirefox(sourceDir) {
  const extension = resolve(sourceDir);
  const rejectedRequests = [];
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    rejectedRequests.push(url.origin);
    return route.abort();
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  let [background] = context.serviceWorkers();
  if (!background) background = await context.waitForEvent('serviceworker');
  return { context, background, rejectedRequests, close: () => context.close() };
}

export async function watchExtension(harness) {
  const targets = new Map([['background', { url: '/_generated_background_page.html', handle: harness.background }]]);
  const remember = (page) => {
    const update = () => targets.set(page, { url: page.url(), handle: page });
    page.on('domcontentloaded', update);
    page.on('close', () => targets.delete(page));
    update();
  };
  harness.context.pages().forEach(remember);
  harness.context.on('page', remember);
  return targets;
}

export { waitForTarget } from './firefox-rdp.mjs';

export async function tabTarget(harness, url) {
  const page = harness.context.pages().find((candidate) => candidate.url() === url)
    || await harness.context.waitForEvent('page');
  await page.waitForURL(url);
  await page.waitForLoadState('domcontentloaded');
  harness.activePage = page;
  return { url, handle: page };
}

export function evaluate(_harness, target, source) {
  return target.handle.evaluate(`(async () => { const browser = globalThis.browser || globalThis.chrome; ${source} })()`);
}

export async function nativePaste(harness, text) {
  await harness.activePage.evaluate((value) => navigator.clipboard.writeText(value), text);
  await harness.activePage.keyboard.press('ControlOrMeta+V');
}
