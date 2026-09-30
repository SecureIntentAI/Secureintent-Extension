import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page, test as base, type Worker } from '@playwright/test';

declare const chrome: {
  storage: {
    local: { set(items: Record<string, unknown>): Promise<void> };
    sync: { set(items: Record<string, unknown>): Promise<void> };
  };
};

export const SITE = 'https://security.example/';
const EXT = fileURLToPath(new URL('../dist/chrome-mv3', import.meta.url));

// Separate from the live-site fixture: each test gets a fresh profile, empty
// auth configuration and a localhost API from the build's very first startup.
export const test = base.extend<{ worker: Worker }>({
  context: async ({}, use) => {
    const manifest = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    expect(manifest.host_permissions).toContain('http://localhost:8788/*');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await context.route('http://localhost:8788/**', (route) => route.abort());
      await context.route(`${SITE}**`, (route) => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><script>
          window.pagePastes = [];
          window.addEventListener('paste', event => {
            window.pagePastes.push(event.clipboardData.getData('text/plain'));
          }, true);
        </script><textarea id="editor" aria-label="Editor"></textarea>
        <div contenteditable="true" role="textbox" aria-label="Rich editor"></div>`,
      }));
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      await worker.evaluate(async () => {
        await chrome.storage.sync.set({ si_terms_consent: { version: 1, acceptedAt: Date.now() } });
      });
      await use(context);
    } finally {
      await context.close();
    }
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'));
  },
});

export async function openEditor(page: Page): Promise<void> {
  const ready = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('· guard active'),
  });
  await page.goto(SITE);
  await ready;
  await page.getByRole('textbox', { name: 'Editor', exact: true }).click();
}

export async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press('ControlOrMeta+V');
}

export async function clickOverlayButton(page: Page, label: string): Promise<void> {
  const overlay = page.locator('secureintent-overlay');
  await expect(overlay).toBeAttached();
  expect(await overlay.evaluate((host) => host.shadowRoot === null)).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  try {
    // CDP locates the production closed-shadow button; the actual action is a
    // trusted mouse click, not calling the extension's callback from the test.
    type DomNode = {
      nodeName: string;
      nodeValue: string;
      backendNodeId: number;
      children?: DomNode[];
      shadowRoots?: DomNode[];
    };
    const text = (node: DomNode): string => node.nodeValue + (node.children ?? []).map(text).join('');
    const find = (node: DomNode): number | undefined => {
      if (node.nodeName === 'BUTTON' && text(node).trim() === label) return node.backendNodeId;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const result = find(child);
        if (result) return result;
      }
    };
    let backendNodeId: number | undefined;
    await expect.poll(async () => {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      backendNodeId = find(root);
      return backendNodeId;
    }, { message: `missing overlay button: ${label}` }).toBeTruthy();
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: backendNodeId! });
    const b = model.content;
    await page.mouse.click((b[0] + b[2] + b[4] + b[6]) / 4, (b[1] + b[3] + b[5] + b[7]) / 4);
  } finally {
    await cdp.detach();
  }
}

export { expect };
