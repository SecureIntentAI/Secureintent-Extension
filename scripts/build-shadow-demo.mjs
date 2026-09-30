import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const website = path.resolve(root, process.env.SHADOW_DASHBOARD_SOURCE || '../secureintent.ai');
const output = path.join(root, process.env.WXT_E2E === '1' ? 'dist-e2e/chrome-mv3' : 'dist-demo/chrome-mv3');
// Read the dashboard first, so a missing sibling checkout fails before building.
let html = await readFile(path.join(website, 'shadow.html'), 'utf8');
const result = spawnSync(path.join(root, 'node_modules/.bin/wxt'), ['build'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, WXT_SHADOW_DEMO: '1', WXT_E2E: process.env.WXT_E2E === '1' ? '1' : '0',
    WXT_API_BASE: 'http://127.0.0.1:18799', WXT_WEB_APP_URL: 'http://127.0.0.1:4173',
    WXT_CLERK_PUBLISHABLE_KEY: '' },
});
if (result.status !== 0) process.exit(result.status || 1);
await mkdir(path.join(output, 'assets/shadow'), { recursive: true });
for (const file of ['styles.css', 'dashboard.css', 'dashboard.js', 'pdf-report.js', 'extension-demo.js', 'inter-latin.woff2', 'OFL.txt']) {
  await cp(path.join(website, 'assets/shadow', file), path.join(output, 'assets/shadow', file));
}
// MV3 extension pages require external scripts; the module restores the theme.
html = html.replace(/\s*<script>([\s\S]*?)<\/script>/g, '');
await writeFile(path.join(output, 'shadow.html'), html);
// WXT derives action.default_title from the popup document title after merging
// user config. Set both after the build so Chrome labels the correct toolbar
// button even when the regular extension is installed beside the demo.
const manifestPath = path.join(output, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.action = { ...manifest.action, default_title: 'SecureIntent · Local Shadow AI Demo' };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const popupPath = path.join(output, manifest.action.default_popup);
const popupHtml = await readFile(popupPath, 'utf8');
await writeFile(popupPath, popupHtml.replace('<title>SecureIntent</title>', '<title>SecureIntent · Local Shadow AI Demo</title>'));
console.log(`\nLoad unpacked: ${output}\nOpen the popup → Live Shadow AI · local demo → Start recording.\nReal browser metadata, stored locally. No sample activity or production upload.\n`);
