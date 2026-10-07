import type { ContentScriptContext } from '#imports';
import { abortable } from '@/lib/async';
import { aiPasteMode, getActiveBundle, getPolicy, isBlockedHost } from '@/lib/config';
import { configItem } from '@/lib/config/store';
import { acceptTerms, consentItem, consentSatisfied, isConsentAccepted } from '@/lib/consent';
import {
  compilePatterns,
  GHOST_EXTRA_PATTERNS,
  mergeCatalog,
  teamPatternsOnly,
} from '@/lib/detection';
import { entitlementItem } from '@/lib/entitlement/store';
import { createPasteProcessor } from '@/lib/paste/client';
import { MAX_PASTE_CHARS } from '@/lib/paste/protocol';
import { recognizeAiPage } from '@/lib/shadow/catalog';
import { mountConsentGate } from '@/overlay/mountConsentGate';
import { enabledItem, isEnabled } from '@/settings';

const MAX_FILE_BYTES = 4_000_000;
const MAX_TOTAL_BYTES = 8_000_000;
const MAX_FILES = 10;
const MAX_PENDING_JOBS = 4;
const TEXT_EXT = /\.(?:json|jsonl|txt|log|env|yaml|yml|csv|md|xml|conf|config|ini)$/i;
const FILE_GUARD_FLAG = '__secureintentFileGuardInstalled__';
const replayed = new WeakSet<Event>();
let consentPrompt: Promise<boolean> | null = null;
let cancelConsentPrompt: (() => void) | undefined;

function textFile(file: File): boolean {
  return (
    TEXT_EXT.test(file.name) || file.type === 'application/json' || file.type.startsWith('text/')
  );
}

type Check = { kind: 'clean' | 'warning' | 'blocked' | 'error'; count: number; message: string };

/** FileReader lets cancellation stop the read, rather than only discard its result. */
function readFileText(file: File, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal.removeEventListener('abort', cancel);
    const cancel = () => {
      reader.abort();
      cleanup();
      reject(signal.reason);
    };
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      cleanup();
      reject(reader.error);
    };
    reader.onabort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      reader.readAsText(file);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** File bytes stay in the browser. One private Worker scans each text file. */
export async function checkFiles(
  files: readonly File[],
  hostname: string,
  pathname = '/',
  signal?: AbortSignal,
): Promise<Check> {
  signal?.throwIfAborted();
  const bundle = await getActiveBundle();
  if (!(await isEnabled()) || bundle.killSwitch) {
    return { kind: 'clean', count: 0, message: '' };
  }
  const policy = getPolicy(bundle);
  const aiMode = aiPasteMode(policy, recognizeAiPage(hostname, pathname)?.id ?? '');
  if (isBlockedHost(hostname, policy.blockedSites) || aiMode === 'block_all') {
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
  const remote = compilePatterns(bundle.patterns);
  const compiled = mergeCatalog(remote);
  const patterns =
    bundle.aggressive === false
      ? compiled.filter((pattern) => pattern.validate !== 'entropy')
      : compiled;
  const extra = teamPatternsOnly(remote) ? [] : GHOST_EXTRA_PATTERNS;
  const wirePatterns = [...patterns, ...extra].map(({ regex, ...pattern }) => ({
    ...pattern,
    source: regex.source,
    flags: regex.flags,
  }));
  let count = 0;
  for (const file of candidates) {
    signal?.throwIfAborted();
    const content = await (signal ? readFileText(file, signal) : file.text());
    if (content.length > MAX_PASTE_CHARS) {
      return { kind: 'error', count, message: 'A text file is too large to check safely.' };
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const processor = await abortable(createPasteProcessor(controller.signal), controller.signal);
      const result = await abortable(
        processor.request('scan', {
          text: content,
          patterns: wirePatterns,
          summary: true,
        }),
        controller.signal,
      );
      count += result.total;
    } finally {
      signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }
  if (count === 0) return { kind: 'clean', count, message: '' };
  if (policy.blockInsteadOfWarn || aiMode === 'block_sensitive') {
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

function askUser(result: Check, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
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
    const cancelPending = () => finish(false);
    const finish = (allow: boolean) => {
      signal.removeEventListener('abort', cancelPending);
      host.remove();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      resolve(allow);
    };
    signal.addEventListener('abort', cancelPending, { once: true });
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
async function ensureFileConsent(ctx: ContentScriptContext, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const bundle = await abortable(getActiveBundle(), signal);
  if (!(await abortable(isEnabled(), signal)) || bundle.killSwitch) return true;
  if (await abortable(isConsentAccepted(), signal)) return true;
  signal.throwIfAborted();
  if (consentPrompt) return abortable(consentPrompt, signal);

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
  return abortable(sharedPrompt, signal);
}

/** Intercept selected text files before page change handlers can start an upload. */
export function installFileGuard(ctx: ContentScriptContext): void {
  const pageState = window as unknown as Record<string, boolean | undefined>;
  if (pageState[FILE_GUARD_FLAG]) return;
  pageState[FILE_GUARD_FLAG] = true;
  type Job = {
    controller: AbortController;
    bytes: number;
    href: string;
    cleanup: () => void;
  };
  const jobs = new Set<Job>();
  const inputJobs = new WeakMap<HTMLInputElement, Job>();
  const nativeChanges = new WeakSet<HTMLInputElement>();
  const nativeCleanups = new Set<() => void>();
  let dropJob: Job | undefined;
  let retainedBytes = 0;
  let disposed = false;
  let capacityNotice: AbortController | undefined;

  const finish = (job: Job) => {
    if (!jobs.delete(job)) return;
    retainedBytes -= job.bytes;
    job.controller.abort();
    job.cleanup();
    if (jobs.size === 0) cancelConsentPrompt?.();
  };
  const changed = () => {
    for (const job of jobs) finish(job);
    capacityNotice?.abort();
  };
  const stopPolicy = configItem.watch(changed);
  const identityScope = (value: Awaited<ReturnType<typeof entitlementItem.getValue>>) => {
    const blob = value?.blob;
    return JSON.stringify([blob?.clerkUserId, blob?.org?.id, blob?.plan, blob?.features]);
  };
  const stopIdentity = entitlementItem.watch((value, previous) => {
    if (identityScope(value) !== identityScope(previous)) changed();
  });
  const stopEnabled = enabledItem.watch(changed);
  // Accepting the initial consent is part of a pending job; revocation cancels it.
  const stopConsent = consentItem.watch((value) => {
    if (!consentSatisfied(value)) changed();
  });

  const begin = (files: readonly File[]): Job | undefined => {
    if (disposed) return;
    // Oversized selections are rejected by checkFiles before reading. Charge at
    // most the whole budget here so their error can still be shown to the user.
    const bytes = Math.min(
      MAX_TOTAL_BYTES,
      files.filter(textFile).reduce((sum, file) => sum + file.size, 0),
    );
    if (jobs.size >= MAX_PENDING_JOBS || retainedBytes + bytes > MAX_TOTAL_BYTES) {
      capacityNotice?.abort();
      capacityNotice = new AbortController();
      void askUser(
        {
          kind: 'error',
          count: 0,
          message:
            'Other file checks are still pending. Finish or cancel them, then try this upload again.',
        },
        capacityNotice.signal,
      );
      return;
    }
    capacityNotice?.abort();
    const job = {
      controller: new AbortController(),
      bytes,
      href: location.href,
      cleanup: () => {},
    };
    jobs.add(job);
    retainedBytes += bytes;
    return job;
  };

  const run = async (job: Job, files: readonly File[], target: Element, replay: () => void) => {
    const { signal } = job.controller;
    const currentDestination = () => {
      // pushState can move the same DOM input onto a differently governed AI
      // route without emitting a navigation event or disconnecting the input.
      if (location.href !== job.href) finish(job);
      return !signal.aborted;
    };
    try {
      if (!(await ensureFileConsent(ctx, signal))) return;
      if (!currentDestination()) return;
      signal.throwIfAborted();
      let result: Check;
      try {
        result = await checkFiles(files, location.hostname, location.pathname, signal);
      } catch {
        signal.throwIfAborted();
        result = {
          kind: 'error',
          count: 0,
          message: 'This file could not be checked. Upload was cancelled.',
        };
      }
      if (!currentDestination()) return;
      signal.throwIfAborted();
      if (result.kind !== 'clean' && !(await askUser(result, signal))) return;
      if (!(await ensureFileConsent(ctx, signal))) return;
      if (!currentDestination()) return;
      signal.throwIfAborted();
      if (!target.isConnected) return;
      try {
        replay();
      } catch {
        await askUser(
          {
            kind: 'error',
            count: 0,
            message: 'This site could not resume the checked upload. Please try again.',
          },
          signal,
        );
      }
    } catch {
      // A superseded or invalidated job must never resume its captured upload.
    } finally {
      finish(job);
    }
  };

  const suppressNativeChange = (input: HTMLInputElement) => {
    nativeChanges.add(input);
    const block = (event: Event) => {
      if (replayed.has(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cleanup();
    };
    const cleanup = () => {
      clearTimeout(timer);
      nativeChanges.delete(input);
      input.removeEventListener('change', block, true);
      nativeCleanups.delete(cleanup);
    };
    const timer = setTimeout(cleanup, 0);
    // A native change inside a shadow root need not reach the window listener.
    input.addEventListener('change', block, true);
    nativeCleanups.add(cleanup);
  };

  const onChange = (event: Event) => {
    if (replayed.has(event)) return;
    const input = event
      .composedPath()
      .find(
        (node): node is HTMLInputElement =>
          node instanceof HTMLInputElement && node.type === 'file',
      );
    if (!input) return;
    if (event.type === 'change' && nativeChanges.has(input)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // Even an empty or unsupported replacement supersedes the previous file.
    const previous = inputJobs.get(input);
    if (previous) finish(previous);
    if (!input.files?.length) return;
    const files = snapshot(input.files);
    if (!files.some(textFile)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (event.type === 'input') suppressNativeChange(input);
    input.value = '';
    const job = begin(files);
    if (!job) return;
    inputJobs.set(input, job);
    const cancel = () => finish(job);
    const form = input.form;
    input.addEventListener('cancel', cancel);
    form?.addEventListener('reset', cancel, true);
    job.cleanup = () => {
      if (inputJobs.get(input) === job) inputJobs.delete(input);
      input.removeEventListener('cancel', cancel);
      form?.removeEventListener('reset', cancel, true);
    };
    void run(job, files, input, () => {
      if (inputJobs.get(input) !== job) return;
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      input.files = transfer.files;
      for (const type of ['input', 'change']) {
        const resumed = new Event(type, { bubbles: true, composed: type === 'input' });
        replayed.add(resumed);
        input.dispatchEvent(resumed);
        // A page handler can reset or replace the input during the first event.
        if (job.controller.signal.aborted || !input.isConnected) break;
      }
    });
  };
  const onDrop = (event: DragEvent) => {
    if (replayed.has(event) || !event.dataTransfer?.files.length) return;
    if (dropJob) finish(dropJob);
    const files = snapshot(event.dataTransfer.files);
    if (!files.some(textFile)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.composedPath().find((node): node is Element => node instanceof Element);
    if (!target) return;
    const job = begin(files);
    if (!job) return;
    dropJob = job;
    job.cleanup = () => {
      if (dropJob === job) dropJob = undefined;
    };
    void run(job, files, target, () => {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      const resumed = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: transfer,
      });
      replayed.add(resumed);
      target.dispatchEvent(resumed);
    });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && jobs.size > 0) {
      event.preventDefault();
      changed();
    }
  };
  window.addEventListener('input', onChange, true);
  window.addEventListener('change', onChange, true);
  window.addEventListener('drop', onDrop, true);
  window.addEventListener('pagehide', changed);
  window.addEventListener('popstate', changed);
  window.addEventListener('hashchange', changed);
  window.addEventListener('keydown', onKeyDown, true);
  ctx.onInvalidated(() => {
    disposed = true;
    changed();
    stopPolicy();
    stopIdentity();
    stopEnabled();
    stopConsent();
    for (const cleanup of nativeCleanups) cleanup();
    window.removeEventListener('input', onChange, true);
    window.removeEventListener('change', onChange, true);
    window.removeEventListener('drop', onDrop, true);
    window.removeEventListener('pagehide', changed);
    window.removeEventListener('popstate', changed);
    window.removeEventListener('hashchange', changed);
    window.removeEventListener('keydown', onKeyDown, true);
    delete pageState[FILE_GUARD_FLAG];
  });
}
