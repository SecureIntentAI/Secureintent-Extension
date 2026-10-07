import { browser, type ContentScriptContext, storage } from '#imports';
import { abortable, withDeadline } from '@/lib/async';
import {
  aiPasteMode,
  DEFAULT_BUNDLE,
  getActiveBundle,
  getPolicy,
  isBlockedHost,
} from '@/lib/config';
import { configItem } from '@/lib/config/store';
import { acceptTerms, consentItem, consentSatisfied, isConsentAccepted } from '@/lib/consent';
import { elapsedMs, siDebug, siError } from '@/lib/debug';
import {
  compilePatterns,
  GHOST_EXTRA_PATTERNS,
  GHOST_MIN_CHARS,
  mergeCatalog,
  TOKEN_RE,
  teamPatternsOnly,
} from '@/lib/detection';
import { getEntitlementSnapshot, hasFeatureCached, initEntitlementCache } from '@/lib/entitlement';
import { entitlementItem } from '@/lib/entitlement/store';
import { notifyAction, notifyDetections } from '@/lib/features';
import {
  computeFingerprint,
  type Fingerprint,
  getOrCreateSalt,
  type KeyValueStore,
  type Salt,
} from '@/lib/fingerprint';
import { createPasteProcessor } from '@/lib/paste/client';
import { MAX_PASTE_CHARS, type PasteProcessor, type ScanResult } from '@/lib/paste/protocol';
import { consumeAnonymize, formatQuotaReset, getAnonymizeStatus } from '@/lib/quota';
import { recognizeAiPage } from '@/lib/shadow/catalog';
import { demoPolicyItem, SHADOW_DEMO } from '@/lib/shadow/demoConfig';
import type { DlpAction } from '@/lib/shadow/visits';
import type { TelemetryAction } from '@/lib/telemetry/types';
import { readVaultEntries, storeVaultEntries } from '@/lib/vault/client';
import { mountOverlay, type OverlayHandle } from '@/overlay/mount';
import { mountConsentGate } from '@/overlay/mountConsentGate';
import { mountPasteStatus, type PasteStatus } from '@/overlay/mountPasteStatus';
import type { OverlayAction } from '@/overlay/Overlay';
import { buildEvent, sendTelemetry } from '@/services/telemetryService';
import { enabledItem, isEnabled, recordBlocked } from '@/settings';
import { isDraftEditor, pasteIntoDraft } from './draftEditorPaste';
import { findComposer } from './findComposer';
import { readClipboardText } from './readClipboard';
import type { SiteConfig } from './types';

/** The telemetry API accepts at most this many findings per paste. */
const MAX_TELEMETRY_FINDINGS = 100;
const browserStore: KeyValueStore = {
  get: async (key) => (await storage.getItem<string>(`local:${key}`)) ?? undefined,
  set: (key, value) => storage.setItem(`local:${key}`, value),
};

export { MAX_PASTE_CHARS } from '@/lib/paste/protocol';
export const ASYNC_PASTE_CHARS = 64_000;
export const MAX_PENDING_PASTES = 8;
export const MAX_PENDING_PASTE_CHARS = 4_000_000;
const PENDING_PASTE_TTL_MS = 30_000;

interface PasteJob {
  pageUrl: string;
  input: HTMLElement;
  controller: AbortController;
  ui?: OverlayHandle;
  uiVersion: number;
  handled: boolean;
  inserting?: boolean;
  selection?: { start: number; end: number } | Range;
  /** Joins the byte-count event to the sensitive-paste outcome. Not the text. */
  shadowPasteId?: string;
  reportOutcome?: (action: DlpAction) => void;
}

/**
 * Rich editors legitimately change whitespace: a pasted "\n" becomes a new
 * paragraph (which Range.toString() reports as nothing) and spaces become
 * non-breaking spaces. Confirm the inserted characters, in order, and ignore
 * how the editor laid out the whitespace between them.
 */
const sameText = (actual: string, expected: string): boolean =>
  actual.replace(/[\s\u00a0\u200b\ufeff]+/g, '') ===
  expected.replace(/[\s\u00a0\u200b\ufeff]+/g, '');

function editableText(el: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.toString();
}

function expectedEditableText(el: HTMLElement, selection: Selection, text: string): string | null {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (!anchorNode || !focusNode || !el.contains(anchorNode) || !el.contains(focusNode)) return null;

  const offsetOf = (node: Node, offset: number) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.setEnd(node, offset);
    return range.toString().length;
  };
  const start = offsetOf(anchorNode, anchorOffset);
  const end = offsetOf(focusNode, focusOffset);
  const before = editableText(el);
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return before.slice(0, from) + text + before.slice(to);
}

type CapturedPaste = {
  pageUrl: string;
  queuedAt: number;
  rejection?: PasteStatus;
  input: HTMLElement;
  path: EventTarget[];
  text: string;
  selection?: { start: number; end: number } | Range;
};

function captureSelection(input: HTMLElement): CapturedPaste['selection'] {
  if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
    if (input.selectionStart !== null && input.selectionEnd !== null) {
      return { start: input.selectionStart, end: input.selectionEnd };
    }
  } else {
    const selection = window.getSelection();
    if (selection?.rangeCount && input.contains(selection.anchorNode)) {
      return selection.getRangeAt(0).cloneRange();
    }
  }
  return undefined;
}

function insertText(
  el: HTMLElement,
  text: string,
  selection?: PasteJob['selection'],
  isCurrent: () => boolean = () => el.isConnected,
  applyInsertion: (action: () => boolean) => boolean = (action) => action(),
): void | Promise<void> {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = selection && 'start' in selection ? selection.start : el.selectionStart;
    const end = selection && 'end' in selection ? selection.end : el.selectionEnd;
    if (start === null || end === null) {
      // type=email/number expose no selection API. The browser still keeps the
      // caret, so insert there and confirm the text landed. (These types also
      // sanitize the value, e.g. drop line breaks, hence the loose comparison.)
      const before = el.value;
      applyInsertion(() => document.execCommand('insertText', false, text));
      const compact = (v: string) => v.replace(/[\s\u00a0]+/g, '');
      if (el.value === before || !compact(el.value).includes(compact(text)))
        throw new Error('The editor did not accept the checked text');
      return;
    }
    if (start < 0 || end < start || end > el.value.length) {
      throw new Error('The saved paste position is no longer valid');
    }
    const expected = el.value.slice(0, start) + text + el.value.slice(end);
    el.setSelectionRange(start, end);
    applyInsertion(() => document.execCommand('insertText', false, text));
    if (el.value !== expected) throw new Error('The editor did not accept the checked text');
    return;
  }

  const sel = window.getSelection();
  if (selection instanceof Range) {
    if (!el.contains(selection.commonAncestorContainer)) {
      throw new Error('The saved paste position is no longer available');
    }
    sel?.removeAllRanges();
    sel?.addRange(selection);
  } else if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) {
    throw new Error('The editor selection could not be restored');
  }
  if (isDraftEditor(el)) return pasteIntoDraft(el, text, isCurrent, applyInsertion);
  const expected = expectedEditableText(el, sel, text);
  if (expected === null) throw new Error('The editor selection could not be checked');

  // Slate editors (e.g. Discord, Notion) keep their own model and ignore
  // execCommand inserts, so let their paste handler update the editor state.
  const slate = el.closest('[data-slate-editor="true"]');
  if (slate) {
    let handled = false;
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      handled = !applyInsertion(() =>
        slate.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        ),
      );
    } catch {
      // Clipboard event support can vary; try the browser insertion path.
    }
    if (handled) {
      if (!sameText(editableText(el), expected)) {
        throw new Error('The editor did not accept the checked text');
      }
      return;
    }
  }

  const inserted = applyInsertion(() => document.execCommand('insertText', false, text));
  if (el.isContentEditable) {
    if (!sameText(editableText(el), expected)) {
      throw new Error('The editor did not accept the checked text');
    }
  } else if (!inserted) {
    throw new Error('The editor refused insertion');
  }
}

// Content scripts from the same extension share one isolated-world `window`, so a
// dedicated per-site guard marks it here and the catch-all fallback guard checks it
// at paste time — preventing a double overlay on the 19 supported sites without
// maintaining an exclude-list.
const DEDICATED_FLAG = '__secureintentDedicated__';
/**
 * Whether the SecureIntent desktop app says the person restored this exact text
 * there with Undo in the last minute. The background asks it; with no desktop
 * app, or one that cannot be asked, the answer is no straight away.
 */
async function restoredOnDesktop(digest: string): Promise<boolean> {
  try {
    return (await browser.runtime.sendMessage({ type: 'si-bridge-allowed', digest })) === true;
  } catch {
    return false;
  }
}

function markDedicated(): void {
  (window as unknown as Record<string, boolean>)[DEDICATED_FLAG] = true;
}
function dedicatedActive(): boolean {
  return Boolean((window as unknown as Record<string, boolean>)[DEDICATED_FLAG]);
}

const SHADOW_VISIT_FLAG = '__secureintentShadowVisit__';
function claimShadowVisit(): boolean {
  const page = window as unknown as Record<string, boolean>;
  if (page[SHADOW_VISIT_FLAG]) return false;
  page[SHADOW_VISIT_FLAG] = true;
  return true;
}

function isSecureIntentAuthenticationPage(): boolean {
  const host = location.hostname.toLowerCase();
  const ownHost = host === 'secureintent.ai' || host === 'www.secureintent.ai';
  const localPilot = host === '127.0.0.1' || host === 'localhost';
  if (!ownHost && !localPilot) return false;
  return ['/account.html', '/business_promo.html', '/lifetime_business_promo.html'].includes(
    location.pathname,
  );
}

export async function createPasteGuard(
  ctx: ContentScriptContext,
  config: SiteConfig,
): Promise<void> {
  const isFallback = config.siteKey === 'fallback';
  const page = window as unknown as Record<string, boolean>;
  const guardKey = `__secureintentStarted_${config.siteKey}__`;
  if (page[guardKey]) return;
  page[guardKey] = true;

  // Capture paste events while storage, entitlement verification, and the
  // active policy are loading. The old listener was registered only after
  // those awaits, leaving a real startup window where Ctrl+V bypassed us.
  let processPaste:
    | ((event: Event, captured?: CapturedPaste, ownsFallbackEvent?: boolean) => Promise<void>)
    | undefined;
  const startupQueue: CapturedPaste[] = [];
  let drainingStartupQueue = false;
  let disposed = false;
  let queuedCharacters = 0;
  let queueNotice: CapturedPaste | undefined;
  const clearQueue = () => {
    startupQueue.length = 0;
    queuedCharacters = 0;
    queueNotice = undefined;
  };
  const enqueue = (captured: CapturedPaste) => {
    const tooLarge = captured.text.length > MAX_PASTE_CHARS;
    if (
      tooLarge ||
      startupQueue.length >= MAX_PENDING_PASTES ||
      queuedCharacters + captured.text.length > MAX_PENDING_PASTE_CHARS
    ) {
      // Retain one text-free notice, never the rejected clipboard contents.
      queueNotice ??= { ...captured, text: '', rejection: tooLarge ? 'too-large' : 'busy' };
      return;
    }
    queuedCharacters += captured.text.length;
    startupQueue.push(captured);
  };
  const captureEarly = (event: Event, text: string): CapturedPaste | undefined => {
    if (isFallback && dedicatedActive()) return;
    const path = event.composedPath();
    const input = findComposer(path, DEFAULT_BUNDLE.sites.fallback.inputSelector);
    if (!input) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    return {
      input,
      path,
      text,
      selection: captureSelection(input),
      pageUrl: location.href,
      queuedAt: Date.now(),
    };
  };
  const routePaste = (event: Event, text: string) => {
    // SecureIntent's own Clerk forms must remain usable while the extension is
    // active. Email addresses and recovery codes are expected authentication
    // input here; intercepting them can prevent the user from signing in to the
    // product that owns the guard.
    if (disposed || isSecureIntentAuthenticationPage()) return;
    if (processPaste) {
      if (isFallback && dedicatedActive()) return;
      return processPaste(event);
    }
    const captured = captureEarly(event, text);
    if (captured) enqueue(captured);
  };
  ctx.addEventListener(
    window,
    'paste',
    (event) => {
      const e = event as ClipboardEvent;
      if (!e.isTrusted || (isFallback && dedicatedActive())) return;
      const text = readClipboardText(e.clipboardData);
      if (text) return routePaste(event, text);
    },
    { capture: true },
  );
  ctx.addEventListener(
    window,
    'beforeinput',
    (event) => {
      const e = event as InputEvent;
      if (!e.isTrusted || e.inputType !== 'insertFromPaste' || e.defaultPrevented) return;
      const text = e.data || readClipboardText(e.dataTransfer);
      if (!text) return;
      const shim = {
        isTrusted: true,
        clipboardData: { getData: () => text },
        composedPath: () => e.composedPath(),
        preventDefault: () => e.preventDefault(),
        stopImmediatePropagation: () => e.stopImmediatePropagation(),
      } as unknown as ClipboardEvent;
      routePaste(shim, text);
    },
    { capture: true },
  );

  // The catch-all guard may be starting in parallel on this same page. Claim
  // the site before yielding so it will not intercept and queue the same paste.
  if (!isFallback) markDedicated();

  const salt: Salt | undefined = await getOrCreateSalt(browserStore).catch((error) => {
    siError(config.name, 'fingerprint salt unavailable; telemetry suppressed', error);
    return undefined;
  });
  let active: PasteJob | undefined;
  const live = (job: PasteJob): boolean => {
    if (active !== job || job.controller.signal.aborted) return false;
    if (job.pageUrl !== location.href) {
      clearQueue();
      finish(job);
      return false;
    }
    return true;
  };
  const finish = (job: PasteJob) => {
    if (active !== job || job.controller.signal.aborted) return;
    job.reportOutcome?.('cancelled');
    active = undefined;
    job.controller.abort();
    job.ui?.remove();
    void drainStartupQueue();
  };
  const present = async (job: PasteJob, mount: () => Promise<OverlayHandle>) => {
    if (!live(job)) return;
    if (!job.input.isConnected) {
      finish(job);
      return;
    }
    const version = ++job.uiVersion;
    job.ui?.remove();
    job.ui = undefined;
    const ui = await mount();
    if (live(job) && job.uiVersion === version && job.input.isConnected) job.ui = ui;
    else ui.remove(); // cancelled or superseded while the UI was mounting
  };
  const status = (job: PasteJob, kind: PasteStatus) =>
    present(job, () => mountPasteStatus(ctx, kind, () => finish(job)));
  const failed = (job: PasteJob, error: unknown) => {
    if (!live(job)) return;
    siError(config.name, 'paste operation failed; insertion was not confirmed', error);
    // Keep the failure available in the console for diagnosis without showing
    // the alarming modal. Release the job so later pastes are not held up.
    finish(job);
  };
  async function drainStartupQueue() {
    if (disposed || !processPaste || drainingStartupQueue || active) return;
    drainingStartupQueue = true;
    try {
      while ((startupQueue.length || queueNotice) && !active && !disposed) {
        let captured = startupQueue.shift();
        if (captured) queuedCharacters -= captured.text.length;
        else {
          captured = queueNotice;
          queueNotice = undefined;
        }
        if (!captured?.input.isConnected || captured.pageUrl !== location.href) continue;
        if (Date.now() - captured.queuedAt > PENDING_PASTE_TTL_MS) {
          captured = { ...captured, text: '', rejection: 'expired' };
        }
        if (!enabled || bundle.killSwitch) {
          if (captured.rejection) continue;
          try {
            await insertText(
              captured.input,
              captured.text,
              captured.selection,
              () =>
                !disposed && captured.pageUrl === location.href && (!enabled || bundle.killSwitch),
            );
          } catch (error) {
            siError(config.name, 'startup paste could not be restored', error);
          }
          continue;
        }
        const replay = {
          isTrusted: true,
          clipboardData: { getData: () => captured.text },
          composedPath: () => captured.path,
          preventDefault: () => {},
          stopImmediatePropagation: () => {},
        } as unknown as ClipboardEvent;
        await processPaste(replay, captured, true);
      }
    } finally {
      drainingStartupQueue = false;
    }
  }
  const act = async (job: PasteJob, action: () => void | Promise<void>) => {
    if (!live(job) || job.handled) return;
    if (!job.input.isConnected) {
      finish(job);
      return;
    }
    job.handled = true;
    try {
      await action();
      finish(job);
    } catch (error) {
      await failed(job, error);
    }
  };
  /** Resolves true once the text is in the composer; false if the job or input went away. */
  const insert = async (job: PasteJob, text: string): Promise<boolean> => {
    if (!live(job) || !job.input.isConnected) return false;
    await insertText(
      job.input,
      text,
      job.selection,
      () => live(job),
      (action) => {
        // Suppress cancellation only during our own synchronous editor event;
        // user edits during Draft's asynchronous selection/render wait cancel it.
        job.inserting = true;
        try {
          return action();
        } finally {
          job.inserting = false;
        }
      },
    );
    return true;
  };
  ctx.addEventListener(window, 'keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape' && active) finish(active);
  });
  const cancelPending = () => {
    clearQueue();
    if (active) finish(active);
  };
  ctx.addEventListener(window, 'pagehide', cancelPending);
  ctx.addEventListener(window, 'popstate', cancelPending);
  ctx.addEventListener(window, 'hashchange', cancelPending);
  ctx.addEventListener(document, 'input', (event) => {
    if (active && !active.inserting && (event as Event).composedPath().includes(active.input)) {
      cancelPending(); // saved selections are stale after the user edits
    }
  });
  ctx.onInvalidated?.(() => {
    disposed = true;
    cancelPending();
  });

  // Terms & Privacy consent, cached synchronously (read in the paste handler
  // before any await). Blocking: no warning is shown until the user accepts.
  let consented = await isConsentAccepted().catch(() => false);
  let reportVisit = () => {};
  const stopConsent = consentItem.watch((value) => {
    consented = consentSatisfied(value);
    if (!consented) cancelPending();
    reportVisit();
  });

  // preventDefault must run before any await, so cache enabled synchronously
  let enabled = await isEnabled().catch(() => true);
  const stopEnabled = enabledItem.watch((value) => {
    enabled = value ?? true;
    if (!enabled) cancelPending();
  });

  // Prime the entitlement cache so the gate can be read synchronously in the
  // overlay action handler (pro features: rehydrate / ghost).
  const stopEntitlement = await initEntitlementCache().catch((error) => {
    siError(config.name, 'entitlement cache unavailable; using free features', error);
    return () => {};
  });
  const accessScope = (value: Awaited<ReturnType<typeof entitlementItem.getValue>>) => {
    const blob = value?.blob;
    return blob
      ? JSON.stringify([blob.clerkUserId, blob.org?.id, blob.plan, blob.pro, blob.features])
      : null;
  };
  let previousAccess = accessScope(await entitlementItem.getValue());
  const stopIdentity = entitlementItem.watch((value) => {
    const nextAccess = accessScope(value);
    if (nextAccess !== previousAccess) cancelPending();
    previousAccess = nextAccess;
  });
  ctx.onInvalidated?.(() => {
    stopConsent();
    stopEnabled();
    stopEntitlement();
    stopIdentity();
  });

  let bundle = await getActiveBundle().catch((error) => {
    siError(config.name, 'policy unavailable; using bundled defaults', error);
    return DEFAULT_BUNDLE;
  });
  let remote = compilePatterns(bundle.patterns);
  let compiled = mergeCatalog(remote);
  // Email/IP detection applies at every paste length, unless the team runs only
  // its own patterns. Standard tuning can drop entropy rules, while Ghost always
  // excludes them to preserve log hashes/SHAs.
  let extra = teamPatternsOnly(remote) ? [] : GHOST_EXTRA_PATTERNS;
  let patterns = [
    ...(bundle.aggressive === false ? compiled.filter((p) => p.validate !== 'entropy') : compiled),
    ...extra,
  ];
  let ghostPatterns = [...compiled.filter((p) => p.validate !== 'entropy'), ...extra];
  let ghostMin =
    typeof bundle.ghost?.minChars === 'number' ? bundle.ghost.minChars : GHOST_MIN_CHARS;
  let inputSelector =
    bundle.sites[config.siteKey]?.inputSelector ??
    DEFAULT_BUNDLE.sites[config.siteKey]?.inputSelector;
  if (!inputSelector) return; // unknown site — nothing to guard

  // Team Policy Sync. A policy can only ride in on a bundle that passed
  // validation + Ed25519 verification in syncConfig — nothing else ever writes
  // the active bundle — so reaching here already means "signed by the Worker".
  let policy = getPolicy(bundle);
  // A blocked destination admits nothing at all — not the raw text, not an
  // anonymised or sanitized version of it. The rule is about the site, not the
  // secret, so every insert path is closed here.
  let policyBlockedHost = isBlockedHost(location.hostname, policy.blockedSites);
  let aiPage =
    window.top === window ? recognizeAiPage(location.hostname, location.pathname) : undefined;
  let demoRules = SHADOW_DEMO ? await demoPolicyItem.getValue().catch(() => []) : [];
  const currentAiMode = () =>
    SHADOW_DEMO
      ? aiPasteMode({ ...policy, aiServices: demoRules }, aiPage?.id)
      : aiPasteMode(policy, aiPage?.id);
  let aiMode = currentAiMode();
  let aiBlocked = aiMode === 'block_all';
  let destinationBlocked = policyBlockedHost || aiBlocked;
  // Under a policy that forbids the raw text, we must NOT re-insert it when our
  // own code throws: that fail-open recovery would turn our bug into exactly the
  // leak the policy exists to stop. The user still isn't trapped — the page and
  // every other paste keep working; only this one paste is dropped.
  let allowRawPaste = !policy.blockInsteadOfWarn && !destinationBlocked;
  const stopConfig = configItem.watch((next) => {
    // Discard pending work before ending a job: ending it can drain the queue.
    cancelPending();
    bundle = next ?? DEFAULT_BUNDLE;
    remote = compilePatterns(bundle.patterns);
    compiled = mergeCatalog(remote);
    extra = teamPatternsOnly(remote) ? [] : GHOST_EXTRA_PATTERNS;
    patterns = [
      ...(bundle.aggressive === false
        ? compiled.filter((p) => p.validate !== 'entropy')
        : compiled),
      ...extra,
    ];
    ghostPatterns = [...compiled.filter((p) => p.validate !== 'entropy'), ...extra];
    ghostMin = typeof bundle.ghost?.minChars === 'number' ? bundle.ghost.minChars : GHOST_MIN_CHARS;
    inputSelector =
      bundle.sites[config.siteKey]?.inputSelector ??
      DEFAULT_BUNDLE.sites[config.siteKey]?.inputSelector;
    policy = getPolicy(bundle);
    policyBlockedHost = isBlockedHost(location.hostname, policy.blockedSites);
    aiMode = currentAiMode();
    aiBlocked = aiMode === 'block_all';
    destinationBlocked = policyBlockedHost || aiBlocked;
    allowRawPaste = !policy.blockInsteadOfWarn && !destinationBlocked;
  });
  ctx.onInvalidated?.(stopConfig);
  if (SHADOW_DEMO) {
    const stopDemoPolicy = demoPolicyItem.watch((rules) => {
      cancelPending();
      demoRules = rules ?? [];
      aiMode = currentAiMode();
      aiBlocked = aiMode === 'block_all';
      destinationBlocked = policyBlockedHost || aiBlocked;
      allowRawPaste = !policy.blockInsteadOfWarn && !destinationBlocked;
    });
    ctx.onInvalidated?.(stopDemoPolicy);
  }

  reportVisit = () => {
    if (!aiPage || !consented) return;
    if (!claimShadowVisit()) return;
    browser.runtime
      .sendMessage({ type: 'si-shadow-visit', eventId: crypto.randomUUID() })
      .catch(() => {});
  };
  reportVisit();

  siDebug(config.name, 'guard active', { selector: inputSelector });
  if (policy.blockInsteadOfWarn || policy.requireSessionLock || policyBlockedHost) {
    siDebug(config.name, 'team policy active', {
      policyVersion: bundle.policyVersion ?? null,
      blockInsteadOfWarn: policy.blockInsteadOfWarn,
      blockedHost: policyBlockedHost,
    });
  }

  // Vault access is origin-bound by the background and expiry checked per read.

  const onPaste = async (event: Event, captured?: CapturedPaste, ownsFallbackEvent = false) => {
    const e = event as ClipboardEvent;
    let job: PasteJob | undefined;
    const intercept = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!job) {
        job = {
          pageUrl: captured?.pageUrl ?? location.href,
          input: captured?.input ?? input,
          controller: new AbortController(),
          uiVersion: 0,
          handled: false,
          selection: captured?.selection ?? captureSelection(input),
        };
        active = job;
      }
      return job;
    };
    let input: HTMLElement;
    try {
      if (disposed) return;
      if (isFallback && dedicatedActive() && !ownsFallbackEvent) return; // a dedicated guard owns this site
      if (!enabled) return; // protection off — let the paste through
      if (bundle.killSwitch) return; // remote kill-switch — let the paste through
      if (!e.isTrusted) return; // ignore programmatic pastes (e.g. our own re-inserts)

      // composedPath includes shadow-internal nodes, so sites whose composer lives
      // inside a web-component shadow root (e.g. Reddit) are matched too.
      // The signed bundle names one selector. ChatGPT remounts the composer, so
      // a paste can land on a contenteditable that is not #prompt-textarea.
      // If the named box is not in the event path, accept any real text field.
      const path = e.composedPath();
      const composer =
        findComposer(path, inputSelector) ??
        findComposer(path, DEFAULT_BUNDLE.sites.fallback.inputSelector);
      if (!composer) return;
      input = composer;
      if (active && (!active.input.isConnected || active.pageUrl !== location.href))
        cancelPending();
      if (active) {
        // Returning alone allows Chrome's default paste to leak raw text.
        e.preventDefault();
        e.stopImmediatePropagation();
        // Preserve a second paste that arrived while the first warning is open.
        // It will be checked after the user resolves the current paste.
        const queuedText = readClipboardText(e.clipboardData);
        if (queuedText) {
          enqueue({
            pageUrl: location.href,
            queuedAt: Date.now(),
            input,
            path: e.composedPath(),
            text: queuedText,
            selection: captureSelection(input),
          });
        }
        return;
      }

      // Single-page navigation can change the AI service without reloading this script.
      aiPage =
        window.top === window ? recognizeAiPage(location.hostname, location.pathname) : undefined;
      aiMode = currentAiMode();
      aiBlocked = aiMode === 'block_all';
      destinationBlocked = policyBlockedHost || aiBlocked;
      allowRawPaste = !policy.blockInsteadOfWarn && !destinationBlocked;
      reportVisit();

      if (captured?.rejection) {
        await status(intercept(), captured.rejection);
        return;
      }
      const text = readClipboardText(e.clipboardData);
      if (!text) return;
      if (text.length > MAX_PASTE_CHARS) {
        await status(intercept(), 'too-large');
        return;
      }
      // Even a short paste can trigger a pathological team regex. No detector
      // runs on the page thread, and no raw default paste may beat the scan.
      const pending = intercept(); // MUST run before the first await
      if (aiPage) {
        pending.shadowPasteId = crypto.randomUUID();
        browser.runtime
          .sendMessage({
            type: 'si-shadow-paste-volume',
            eventId: pending.shadowPasteId,
            byteSize: new TextEncoder().encode(text).byteLength,
          })
          .catch(() => {});
      }
      const ghostMode = text.length >= ghostMin;
      const tDetect = performance.now();
      if (text.length >= ASYNC_PASTE_CHARS) {
        await status(pending, 'checking');
        if (!live(pending)) return;
      }
      // Avoid flashing a dialog for ordinary fast scans; slow/large work is
      // cancellable through the status and Escape throughout the operation.
      const checkingTimer =
        text.length < ASYNC_PASTE_CHARS
          ? setTimeout(() => {
              void status(pending, 'checking').catch((error) => failed(pending, error));
            }, 120)
          : undefined;
      let scan: ScanResult;
      let processor: PasteProcessor;
      try {
        processor = await createPasteProcessor(pending.controller.signal);
        scan = await processor.request('scan', {
          text,
          patterns: (ghostMode ? ghostPatterns : patterns).map(({ regex, ...pattern }) => ({
            ...pattern,
            source: regex.source,
            flags: regex.flags,
          })),
          summary: ghostMode,
          // Only the paste guard fingerprints a summary scan's findings for telemetry.
          sample: ghostMode,
        });
      } finally {
        clearTimeout(checkingTimer);
      }
      if (!live(pending)) return;
      const detections = scan.detections;
      const detectMs = elapsedMs(tDetect);
      const sensitivePasteBlocked = aiMode === 'block_sensitive' && scan.total > 0;
      destinationBlocked = policyBlockedHost || aiBlocked || sensitivePasteBlocked;
      allowRawPaste = !policy.blockInsteadOfWarn && !destinationBlocked;
      if (aiPage && scan.total > 0 && pending.shadowPasteId) {
        let reported = false;
        pending.reportOutcome = (action) => {
          if (reported || !consented) return;
          reported = true;
          browser.runtime
            .sendMessage({
              type: 'si-shadow-dlp',
              eventId: crypto.randomUUID(),
              pasteEventId: pending.shadowPasteId,
              detectionType: scan.types[0] ?? 'known-key',
              reason: (scan.labels[0] ?? 'Sensitive information').slice(0, 100),
              action: destinationBlocked ? 'blocked' : action,
              findingCount: scan.total,
            })
            .catch(() => {});
        };
      }
      if (destinationBlocked && scan.total > 0) pending.reportOutcome?.('blocked');

      // Rehydrate: if the pasted text carries our tokens, prompt to swap them
      // back to the real secrets at insert time (or keep the tokens / cancel).
      // The secret stays out of the OS clipboard — it only ever materializes on
      // insert. Rehydrate is a Pro feature: without the
      // entitlement, skip the prompt entirely and let the tokens paste as-is.
      // Only offer this where raw secrets are permitted. A mixed paste that
      // already contains raw secrets must go through the ordinary warning;
      // "keep tokens" must not become an unchecked route for those secrets.
      if (
        allowRawPaste &&
        // Restoring a token materializes the original secret after the scan.
        // Treat that as a sensitive paste under a destination's block rule.
        aiMode !== 'block_sensitive' &&
        scan.total === 0 &&
        hasFeatureCached('rehydrate') &&
        TOKEN_RE.test(text)
      ) {
        const tokens = new Set(text.match(new RegExp(TOKEN_RE.source, 'g')) ?? []);
        const snapshot = await readVaultEntries();
        if (!live(pending)) return;
        const entries: [string, string][] = [];
        for (const token of tokens) {
          const secret = snapshot[token];
          if (secret !== undefined) entries.push([token, secret]);
        }
        const { tokenCount: known } = await processor.request('rehydrate', entries);
        if (!live(pending)) return;
        if (known > 0) {
          await present(pending, () =>
            mountOverlay(ctx, {
              site: config.name,
              text,
              detections: [],
              rehydrate: { tokenCount: known },
              onAction: (action) =>
                act(pending, async () => {
                  if (!hasFeatureCached('rehydrate') && action === 'rehydrate') return;
                  if (action === 'rehydrate') {
                    const current = await readVaultEntries();
                    const fresh = [...tokens].flatMap((token): [string, string][] =>
                      current[token] === undefined ? [] : [[token, current[token]]],
                    );
                    const restored = await processor.request('rehydrate', fresh);
                    if (!restored.tokenCount) throw new Error('Restoration tokens expired');
                    if (hasFeatureCached('rehydrate')) await insert(pending, restored.text);
                  } else if (action === 'paste') await insert(pending, text); // keep tokens as-is
                  // cancel → drop the paste entirely
                  siDebug(config.name, 'rehydrate prompt', { action, tokens: known });
                }),
            }),
          );
          return;
        }
        // Unknown/expired tokens aren't secrets — fall through to normal handling.
      }

      // A blocked destination is about the SITE, not the secret: the admin is
      // told "the extension refuses every paste, whether or not it finds a
      // secret", so a clean paste must be stopped here too. Letting it through
      // would quietly break the promise the console makes to whoever set the
      // rule — and these are the sites a team has decided to feed nothing.
      if (scan.total === 0 && !destinationBlocked) {
        // Plain-text insertion only after a complete scan, preserving the
        // user's original selection even if focusing the site changes it.
        await act(pending, async () => {
          await insert(pending, text);
        });
        return;
      }
      // Show the actual secret warning for this paste. Extracted so the
      // consent gate can call it after the user agrees (first-paste consent).
      const showWarning = async () => {
        if (!live(pending)) return;
        // The desktop app redacts on copy, and Undo there is the person saying
        // they want the real text. Pasting it here straight after is that same
        // decision, so it is treated as "Paste anyway" rather than asked again.
        // Only where the raw paste is allowed at all: a team's block policy is
        // not something an Undo overrides.
        const undone = allowRawPaste && (await restoredOnDesktop(scan.handledDigest));
        if (!live(pending)) return;
        if (!undone) {
          recordBlocked(scan.total); // popup total; on-device only
          // per-tab action badge (background owns browser.action)
          browser.runtime.sendMessage({ type: 'si-detected', count: scan.total }).catch(() => {});
        }

        // Feature-hook seam: registered features observe detections (metadata
        // only — raw text is never passed). Fire-and-forget.
        const featureCtx = {
          site: config.name,
          siteKey: config.siteKey,
          detectionCount: scan.total,
          types: scan.types,
          labels: scan.labels,
        };
        notifyDetections(featureCtx);

        // One fingerprint per finding, for at most the first 100 (the API's cap).
        // Large (Ghost) pastes and pastes with more findings are reported too:
        // the team Overview counts pastes, so a sample is enough.
        const telemetrySample = (detections.length ? detections : (scan.sample ?? [])).slice(
          0,
          MAX_TELEMETRY_FINDINGS,
        );
        const fingerprintsPromise =
          !salt || telemetrySample.length === 0
            ? null
            : Promise.all(
                telemetrySample.map(async (d) => {
                  const fingerprint = await computeFingerprint(d.match, salt);
                  siDebug(config.name, 'fingerprint', { label: d.label, fingerprint });
                  return { fingerprint, type: d.type, label: d.label };
                }),
              ).catch(
                (
                  err,
                ): {
                  fingerprint: Fingerprint;
                  type: (typeof detections)[number]['type'];
                  label: string;
                }[] => {
                  siError(config.name, 'fingerprint error, telemetry suppressed', err);
                  return [];
                },
              );

        // Gate the pro action for this overlay. Ghost pastes need the `ghost`
        // feature (Pro-only). Standard anonymise is free with a monthly quota,
        // then Pro — the status below reflects Pro OR remaining free allowance.
        const snapshot = getEntitlementSnapshot();
        let quota = null;
        if (!ghostMode && !undone) {
          await status(pending, 'checking');
          if (!live(pending)) return;
          quota = await abortable(
            withDeadline(() => getAnonymizeStatus(snapshot)),
            pending.controller.signal,
          );
        }
        if (!live(pending)) return;
        const proAction = ghostMode
          ? hasFeatureCached('ghost')
          : Boolean(quota && (quota.unlimited || quota.remaining > 0));
        // "Spent your free allowance" is a different situation from "never had
        // this feature", so the overlay is told which one it is: a user at 0/10
        // needs the reset date, not a plain Pro badge.
        const quotaExhausted =
          quota && !quota.unlimited && quota.remaining <= 0
            ? { limit: quota.limit, resetsOn: formatQuotaReset() }
            : undefined;

        const onAction = (action: OverlayAction) =>
          act(pending, async () => {
            if (action === 'upgrade') {
              // Hand off to the background to open the account page — the one
              // place an already-installed user can actually buy or manage a plan.
              browser.runtime.sendMessage({ type: 'si-open-upgrade' }).catch(() => {});
              return;
            }
            if (action === 'rehydrate') return; // only the rehydrate overlay emits this
            // What actually happened, for team telemetry. Set only once an insert
            // really landed; a refused action is reported as cancelled. A paste
            // that fails part-way (worker, quota, insert error) sends nothing.
            let outcome: TelemetryAction = 'cancelled';
            // `allowRawPaste` is re-checked here, not just in the UI: the
            // policy has to hold even if the overlay were driven some other
            // way. Under a block the paste is simply dropped (= cancel).
            if (action === 'paste') {
              if (allowRawPaste && (await insert(pending, text))) {
                outcome = 'paste_anyway';
                pending.reportOutcome?.('warning_bypassed');
              }
            } else if (
              action === 'sanitize' &&
              proAction &&
              hasFeatureCached('ghost') &&
              !destinationBlocked
            ) {
              // Ghost: strip every finding to a typed placeholder. Irreversible.
              await status(pending, 'checking');
              if (!live(pending)) return;
              const sanitized = await processor.request('sanitize', null);
              if (
                hasFeatureCached('ghost') &&
                live(pending) &&
                (await insert(pending, sanitized))
              ) {
                outcome = 'sanitised';
                pending.reportOutcome?.('sanitised');
              }
            } else if (action === 'redact' && proAction && !destinationBlocked) {
              // The preview can become stale while the warning is open. Do
              // not insert when the actual consume is refused or cancelled.
              await status(pending, 'checking');
              if (!live(pending)) return;
              // Prepare before consuming allowance: an expired/failed worker
              // must not charge a user for a paste that cannot be produced.
              const { text: masked, entries } = await processor.request('tokenize', null);
              if (!live(pending) || !input.isConnected) return;
              const allowed = await abortable(
                withDeadline(() => consumeAnonymize(getEntitlementSnapshot())),
                pending.controller.signal,
              );
              if (!allowed) throw new Error('Anonymise allowance is no longer available');
              if (!live(pending) || !input.isConnected) return;
              // Dehydrate: replace secrets with reversible tokens and stash the
              // token→secret map so a later paste can rehydrate them.
              await storeVaultEntries(entries);
              if (!live(pending)) return;
              if (await insert(pending, masked)) {
                outcome = 'paste_anonymously';
                pending.reportOutcome?.('sanitised');
              }
            }
            notifyAction({ ...featureCtx, action }); // pro: audit log / team report
            // We showed a warning for this copy, so the desktop app, if the
            // person runs it, should not raise its own for the same one. Only
            // the digest the worker computed leaves this frame, and the
            // background keys it with the pairing token before anything goes
            // on the wire; pasted text never travels to the desktop or a
            // server. With no desktop app, the background drops it.
            browser.runtime
              .sendMessage({ type: 'si-bridge-handled', digest: scan.handledDigest })
              .catch(() => {});
            if (fingerprintsPromise) {
              // A refused "paste" inserted nothing, so it is reported as
              // cancelled, never as paste_anyway. Under a team block it is
              // `blocked`, matching the Shadow AI ledger.
              const telemetryAction: TelemetryAction = destinationBlocked ? 'blocked' : outcome;
              fingerprintsPromise.then((dets) => {
                if (dets.length === 0) return;
                sendTelemetry(
                  buildEvent(
                    {
                      site: config.name,
                      policyVersion: bundle.policyVersion ?? 0,
                      detections: dets,
                      action: telemetryAction,
                      plan: snapshot.plan,
                      source: snapshot.source,
                      signedIn: snapshot.signedIn,
                      businessDomain: snapshot.businessDomain,
                      orgId: snapshot.orgId,
                      actorId: snapshot.actorId,
                    },
                    snapshot.signedIn && snapshot.userId
                      ? { userId: snapshot.userId, orgId: snapshot.orgId }
                      : null,
                  ),
                );
              });
            }
          });

        if (undone) {
          await onAction('paste');
          siDebug(config.name, 'paste allowed: restored with Undo in the desktop app', {
            secrets: scan.total,
          });
          return;
        }

        const tMount = performance.now();
        await present(pending, () =>
          mountOverlay(ctx, {
            site: config.name,
            text,
            detections,
            summary: scan.summary,
            findingCount: scan.total,
            locations: scan.locations,
            pro: proAction,
            quotaExhausted,
            // Team policy: a blocked destination gets the notice view (no paste
            // route at all); blockInsteadOfWarn just drops "Paste anyway".
            policyBlock: destinationBlocked
              ? { host: location.hostname, sensitiveOnly: sensitivePasteBlocked }
              : undefined,
            blockRawPaste: policy.blockInsteadOfWarn,
            onAction,
          }),
        );

        siDebug(config.name, 'paste blocked', {
          secrets: scan.total,
          types: scan.types,
          detectMs,
          mountMs: elapsedMs(tMount),
        });
      };

      // Blocking consent gate: on the first paste that would warn, require the
      // user to accept Terms & Privacy before the extension protects anything.
      if (!consented) {
        let agreed = false;
        await present(pending, () =>
          mountConsentGate(ctx, {
            onAgree: () => {
              if (!live(pending) || agreed) return;
              agreed = true;
              void acceptTerms()
                .then(() => showWarning())
                .catch((error) => failed(pending, error));
            },
            onCancel: () => finish(pending),
          }),
        );
        return;
      }

      await showWarning();
    } catch (err) {
      if (job) await failed(job, err);
      else {
        e.preventDefault();
        e.stopImmediatePropagation();
        siError(config.name, 'paste guard error; paste blocked', err);
      }
    }
  };
  processPaste = onPaste;
  void drainStartupQueue();
  const protectionListener = (
    message: unknown,
    _sender: unknown,
    respond: (value: unknown) => void,
  ) => {
    if (
      (message as { type?: string })?.type === 'si-policy-probe' &&
      !(isFallback && dedicatedActive())
    ) {
      void browser.runtime
        .sendMessage({
          type: 'si-policy-receipt',
          nonce: (message as { nonce?: string }).nonce,
          orgId: bundle.policy?.orgId ?? null,
          version: bundle.policyVersion ?? 0,
          active: enabled && consented && !bundle.killSwitch,
        })
        .catch(() => {});
      return false;
    }
    if (
      (message as { type?: string })?.type !== 'si-protection-status' ||
      (isFallback && dedicatedActive())
    )
      return false;
    respond({ ready: true, active: enabled && !bundle.killSwitch });
    return false;
  };
  browser.runtime.onMessage.addListener(protectionListener);
  ctx.onInvalidated?.(() => browser.runtime.onMessage.removeListener(protectionListener));
}
