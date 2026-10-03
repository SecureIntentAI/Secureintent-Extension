// Isolated production-mode auth build; never replaces release artifacts.
import { tmpdir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { build } from 'wxt';

const [browser, outDir] = process.argv.slice(2);
if (!['firefox', 'chrome'].includes(browser) || !outDir || !isAbsolute(outDir)) {
  throw new Error('Usage: build-local-auth.mjs <firefox|chrome> <absolute-temporary-output>');
}
if (!resolve(outDir).startsWith(`${resolve(tmpdir())}${sep}`)) {
  throw new Error('Local auth artifacts must stay inside the system temporary directory');
}
const api = new URL(process.env.WXT_API_BASE || '');
if (!['127.0.0.1', 'localhost'].includes(api.hostname) || !process.env.WXT_POLICY_PUBLIC_KEY) {
  throw new Error('Local auth build requires a loopback API and explicit test signing public key');
}
const clerkFixture = process.env.SI_CLERK_FIXTURE;
if (clerkFixture && !resolve(clerkFixture).startsWith(`${resolve(outDir)}${sep}`)) {
  throw new Error('The Clerk fixture must belong to this temporary build directory');
}
await build({
  browser, outDir, mode: 'production',
  ...(clerkFixture ? { vite: () => ({ resolve: { alias: [
    { find: /^@clerk\/chrome-extension\/client$/, replacement: clerkFixture },
    { find: /^@clerk\/chrome-extension$/, replacement: clerkFixture },
  ] } }) } : {}),
});
