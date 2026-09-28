import type { ContentScriptContext } from '#imports';
import { getActiveBundle, getPolicy, isBlockedHost } from '@/lib/config';
import { acceptTerms, isConsentAccepted } from '@/lib/consent';
import { compilePatterns, mergeCatalog } from '@/lib/detection';
import { createPasteProcessor } from '@/lib/paste/client';
import { MAX_PASTE_CHARS } from '@/lib/paste/protocol';
import { mountConsentGate } from '@/overlay/mountConsentGate';
import { isEnabled } from '@/settings';

const MAX_FILE_BYTES = 4_000_000;
const MAX_TOTAL_BYTES = 8_000_000;
const MAX_FILES = 10;
const TEXT_EXT = /\.(?:json|jsonl|txt|log|env|yaml|yml|csv|md|xml|conf|config|ini)$/i;
const FILE_GUARD_FLAG = '__secureintentFileGuardInstalled__';
const replayed = new WeakSet<Event>();
const pendingNativeChange = new WeakSet<HTMLInputElement>();
let consentPrompt: Promise<boolean> | null = null;
let cancelConsentPrompt: (() => void) | undefined;

function textFile(file: File): boolean {
  return (
    TEXT_EXT.test(file.name) || file.type === 'application/json' || file.type.startsWith('text/')
  );
}

type Check = { kind: 'clean' | 'warning' | 'blocked' | 'error'; count: number; message: string };

/** File bytes stay in the browser. One private Worker scans each text file. */
export async function checkFiles(files: readonly File[], hostname: string): Promise<Check> {
  const bundle = await getActiveBundle();
  if (!(await isEnabled()) || bundle.killSwitch) {
    return { kind: 'clean', count: 0, message: '' };
  }
  const policy = getPolicy(bundle);
  if (isBlockedHost(hostname, policy.blockedSites)) {
    return { kind: 'blocked', count: 0, message: 'Your team blocks uploads to this site.' };
  }
  const candidates = files.filter(textFile);
  if (candidates.length === 0) return { kind: 'clean', count: 0, message: '' };
  if (
    files.length > MAX_FILES ||
    candidates.some((file) => file.size > MAX_FILE_BYTES) ||
    candidates.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES
  ) {
    return {
      kind: 'error',
      count: 0,
      message: 'Too many files or a text file is too large to check safely.',
    };
  }
  const compiled = mergeCatalog(compilePatterns(bundle.patterns));
  const patterns =
    bundle.aggressive === false
      ? compiled.filter((pattern) => pattern.validate !== 'entropy')
      : compiled;
  const wirePatterns = patterns.map(({ regex, ...pattern }) => ({
    ...pattern,
    source: regex.source,
    flags: regex.flags,
  }));
  let count = 0;
  for (const file of candidates) {
    const content = await file.text();
    if (content.length > MAX_PASTE_CHARS) {
      return { kind: 'error', count, message: 'A text file is too large to check safely.' };
    }
    const controller = new AbortController();
    try {
      const processor = await createPasteProcessor(controller.signal);
      const result = await processor.request('scan', {
        text: content,
        patterns: wirePatterns,
        summary: true,
      });
      count += result.total;
    } finally {
      controller.abort();
    }
  }
  if (count === 0) return { kind: 'clean', count, message: '' };
  if (policy.blockInsteadOfWarn) {
    return {
      kind: 'blocked',
      count,
      message: `Your team blocks uploads containing sensitive information (${count} finding${count === 1 ? '' : 's'}).`,
    };
  }
  return {
    kind: 'warning',
    count,
    message: `SecureIntent found ${count} possible secret${count === 1 ? '' : 's'} in the selected file${files.length === 1 ? '' : 's'}.`,
  };
}

function askUser(result: Check): Promise<boolean> {
  return new Promise((resolve) => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const host = document.createElement('secureintent-file-check');
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '2147483647';
    const shadow = host.attachShadow({
      mode:
        (import.meta.env as Record<string, string | undefined>).WXT_E2E === '1' ? 'open' : 'closed',
    });
    const panel = document.createElement('div');
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'secureintent-file-check-title');
    panel.style.cssText =
      'box-sizing:border-box;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(420px,90vw);padding:24px;border-radius:12px;background:#111827;color:#fff;font:14px system-ui;box-shadow:0 0 0 100vmax #0009';
    const title = document.createElement('h2');
    title.id = 'secureintent-file-check-title';
    title.textContent = 'SecureIntent file check';
    const body = document.createElement('p');
    body.textContent = result.message;
    const note = document.createElement('p');
    note.textContent =
      'Scanning happens on this device. If you continue, this site receives the file.';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel upload';
    const finish = (allow: boolean) => {
      host.remove();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      resolve(allow);
    };
    cancel.addEventListener('click', () => finish(false));
    panel.append(title, body, note, cancel);
    const buttons = [cancel];
    if (result.kind === 'warning') {
      const allow = document.createElement('button');
      allow.type = 'button';
      allow.textContent = 'Upload anyway';
      allow.style.marginLeft = '12px';
      allow.addEventListener('click', () => finish(true));
      panel.append(allow);
      buttons.push(allow);
    }
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && shadow.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && shadow.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    shadow.append(panel);
    document.documentElement.append(host);
    cancel.focus();
  });
}

function snapshot(files: FileList): File[] {
  return Array.from(files);
}

/** Require current terms before reading or passing a selected file to the page. */
async function ensureFileConsent(ctx: ContentScriptContext): Promise<boolean> {
  const bundle = await getActiveBundle();
  if (!(await isEnabled()) || bundle.killSwitch) return true;
  if (await isConsentAccepted()) return true;
  if (consentPrompt) return consentPrompt;

  const prompt = new Promise<boolean>((resolve) => {
    let decided = false;
    let accepting = false;
    let handle: { remove(): void } | undefined;
    const finish = (accepted: boolean) => {
      if (decided) return;
      decided = true;
      cancelConsentPrompt = undefined;
      handle?.remove();
      resolve(accepted);
    };
    cancelConsentPrompt = () => finish(false);
    void mountConsentGate(ctx, {
      contentKind: 'file',
      onAgree: () => {
        if (accepting || decided) return;
        accepting = true;
        void acceptTerms()
          .then(() => finish(true))
          .catch(() => finish(false));
      },
      onCancel: () => finish(false),
    })
      .then((mounted) => {
        handle = mounted;
        if (decided) handle.remove();
      })
      .catch(() => finish(false));
  });
  const sharedPrompt = prompt.finally(() => {
    consentPrompt = null;
  });
  consentPrompt = sharedPrompt;
  return sharedPrompt;
}

/** Intercept selected text files before page change handlers can start an upload. */
export function installFileGuard(ctx: ContentScriptContext): void {
  const pageState = window as unknown as Record<string, boolean | undefined>;
  if (pageState[FILE_GUARD_FLAG]) return;
  pageState[FILE_GUARD_FLAG] = true;

  const onChange = (event: Event) => {
    if (replayed.has(event)) return;
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    if (event.type === 'change' && pendingNativeChange.has(input)) {
      pendingNativeChange.delete(input);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!input.files?.length) return;
    const files = snapshot(input.files);
    if (!files.some(textFile)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (event.type === 'input') {
      pendingNativeChange.add(input);
      setTimeout(() => pendingNativeChange.delete(input), 0);
    }
    input.value = '';
    void (async () => {
      let result: Check;
      try {
        if (!(await ensureFileConsent(ctx))) return;
        result = await checkFiles(files, location.hostname);
      } catch {
        result = {
          kind: 'error',
          count: 0,
          message: 'This file could not be checked. Upload was cancelled.',
        };
      }
      if (result.kind !== 'clean' && !(await askUser(result))) return;
      if (!(await ensureFileConsent(ctx))) return;
      if (!input.isConnected) return;
      try {
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(file);
        input.files = transfer.files;
        for (const type of ['input', 'change']) {
          const resumed = new Event(type, { bubbles: true });
          replayed.add(resumed);
          input.dispatchEvent(resumed);
        }
      } catch {
        await askUser({
          kind: 'error',
          count: 0,
          message: 'This site could not resume the checked upload. Please try again.',
        });
      }
    })();
  };
  const onDrop = (event: DragEvent) => {
    if (replayed.has(event) || !event.dataTransfer?.files.length) return;
    const files = snapshot(event.dataTransfer.files);
    if (!files.some(textFile)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target;
    void (async () => {
      let result: Check;
      try {
        if (!(await ensureFileConsent(ctx))) return;
        result = await checkFiles(files, location.hostname);
      } catch {
        result = {
          kind: 'error',
          count: 0,
          message: 'This file could not be checked. Drop was cancelled.',
        };
      }
      if (result.kind !== 'clean' && !(await askUser(result))) return;
      if (!(await ensureFileConsent(ctx))) return;
      if (!(target instanceof Element) || !target.isConnected) return;
      try {
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(file);
        const resumed = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        });
        replayed.add(resumed);
        target.dispatchEvent(resumed);
      } catch {
        await askUser({
          kind: 'error',
          count: 0,
          message: 'This site could not resume the checked drop. Use its file picker instead.',
        });
      }
    })();
  };
  window.addEventListener('input', onChange, true);
  window.addEventListener('change', onChange, true);
  window.addEventListener('drop', onDrop, true);
  ctx.onInvalidated(() => {
    cancelConsentPrompt?.();
    window.removeEventListener('input', onChange, true);
    window.removeEventListener('change', onChange, true);
    window.removeEventListener('drop', onDrop, true);
    delete pageState[FILE_GUARD_FLAG];
  });
}
