// No credentials: launch the actual extension, exercise Firefox cookie/storage
// APIs in its background page, then verify the popup renders in the same profile.
import assert from 'node:assert/strict';
import { evaluate, launchFirefox, waitForTarget, watchExtension } from './firefox-rdp.mjs';

const sourceDir = process.argv[2];
if (!sourceDir) throw new Error('Usage: node scripts/e2e/firefox-smoke.mjs <firefox-extension-dir>');
const harness = await launchFirefox(sourceDir);
try {
  const targets = await watchExtension(harness);
  const background = await waitForTarget(targets, (target) => target.url.endsWith('/_generated_background_page.html'));
  const result = await evaluate(harness, background, `
    const url = 'https://secureintent.ai/';
    await browser.cookies.set({ url, name: 'si_harness_probe', value: 'synthetic-only', secure: true, httpOnly: true, sameSite: 'lax' });
    const cookie = await browser.cookies.get({ url, name: 'si_harness_probe' });
    await browser.cookies.remove({ url, name: 'si_harness_probe' });
    await browser.storage.session.set({ si_harness_probe: 'ok' });
    const session = await browser.storage.session.get('si_harness_probe');
    await browser.storage.session.remove('si_harness_probe');
    await browser.tabs.create({ url: browser.runtime.getURL('popup.html') });
    return { cookie: cookie?.value, httpOnly: cookie?.httpOnly, session: session.si_harness_probe, version: browser.runtime.getManifest().version };
  `);
  assert.deepEqual(result, { cookie: 'synthetic-only', httpOnly: true, session: 'ok', version: '1.2.0' });
  const popup = await waitForTarget(targets, (target) => target.url.endsWith('/popup.html'));
  const popupState = await evaluate(harness, popup, `
    const started = Date.now();
    while (!document.body.innerText && Date.now() - started < 5000) await new Promise(done => setTimeout(done, 50));
    return { title: document.title, text: document.body.innerText };
  `);
  assert.match(popupState.text, /SecureIntent/i);
  console.log(JSON.stringify({ ok: true, browser: 'system Firefox', background: 'started', cookieApi: 'HttpOnly read/write verified', sessionStorage: 'verified', popup: popupState.title, externalRequestsBlocked: harness.rejectedRequests.length }));
} finally {
  await harness.close();
}
