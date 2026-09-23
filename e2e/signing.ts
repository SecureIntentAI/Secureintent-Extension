import { createPrivateKey, sign } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';

// Public, deterministic TEST key. Its public half exists only in WXT_E2E builds.
const key = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${'01'.repeat(32)}`, 'hex'), format: 'der', type: 'pkcs8' });
export async function seedPro(context: BrowserContext) {
  // Finish the normal signed-out startup refresh before installing this fixture.
  const control = await context.newPage();
  await control.goto(`chrome-extension://${new URL(context.serviceWorkers()[0].url()).host}/popup.html`);
  await control.evaluate(async () => {
    const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } } }).chrome.runtime;
    await runtime.sendMessage({ type: 'si-refresh-entitlement' });
  });
  await control.close();
  const blob = { clerkUserId: 'user_e2e', plan: 'developer_pro', source: 'manual',
    pro: true, features: ['rehydrate', 'ghost', 'session_lock'], status: 'active',
    businessDomain: null, issuedAt: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const payload = JSON.stringify(blob);
  const stored = { blob, payload, signature: sign(null, Buffer.from(payload), key).toString('base64') };
  await context.serviceWorkers()[0].evaluate(async (value) => {
    const api = (globalThis as unknown as { chrome: { storage: { local: { set(value: unknown): Promise<void> } } } }).chrome;
    await api.storage.local.set({ si_entitlement: value });
  }, stored);
}
