import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { type BundlePolicy, DEFAULT_BUNDLE, saveBundle } from '@/lib/config';
import { acceptTerms, consentItem } from '@/lib/consent';
import { createPasteProcessor } from '@/lib/paste/client';
import { createPasteComputation } from '@/lib/paste/process';
import type { PasteCommand } from '@/lib/paste/protocol';
import { consumeAnonymize, getAnonymizeStatus } from '@/lib/quota';
import type { OverlayAction } from '@/overlay/Overlay';
import * as telemetryService from '@/services/telemetryService';
import { getBlockedCount, setEnabled } from '@/settings';
import { ASYNC_PASTE_CHARS, createPasteGuard, MAX_PASTE_CHARS } from './createPasteGuard';

vi.mock('@/lib/vault/client', async () => {
  const { handleVaultMessage } = await import('@/services/vaultBackground');
  return {
    storeVaultEntries: async (entries: import('@/lib/detection').VaultEntry[]) =>
      handleVaultMessage({ type: 'si-vault-put', entries }, location.href),
    readVaultEntries: async () =>
      (await handleVaultMessage({ type: 'si-vault-read' }, location.href)).entries,
  };
});

// Mock the shadow-DOM overlay: capture props, return a fake handle.
const { mountOverlayMock } = vi.hoisted(() => ({ mountOverlayMock: vi.fn() }));
vi.mock('../overlay/mount', () => ({ mountOverlay: mountOverlayMock }));

// Mock the consent gate mount (closed shadow DOM can't render in jsdom).
const { mountConsentGateMock } = vi.hoisted(() => ({ mountConsentGateMock: vi.fn() }));
vi.mock('../overlay/mountConsentGate', () => ({ mountConsentGate: mountConsentGateMock }));
const { mountPasteStatusMock } = vi.hoisted(() => ({ mountPasteStatusMock: vi.fn() }));
vi.mock('../overlay/mountPasteStatus', () => ({ mountPasteStatus: mountPasteStatusMock }));

beforeEach(() => {
  mountPasteStatusMock.mockReset();
  mountPasteStatusMock.mockResolvedValue({ remove: vi.fn(), update: vi.fn() });
});

// Mock the entitlement gate. Default: pro unlocked (existing behavior tests).
// proRef.value → ghost gating (hasFeatureCached). anonRef.value → anonymise
// allowance: true = free quota left, false = quota exhausted (0 of 10 remaining).
const { proRef, anonRef } = vi.hoisted(() => ({
  proRef: { value: true },
  anonRef: { value: true },
}));
vi.mock('@/lib/entitlement', () => ({
  initEntitlementCache: vi.fn(async () => () => {}),
  hasFeatureCached: vi.fn(() => proRef.value),
  getEntitlementSnapshot: vi.fn(() => ({
    plan: 'developer',
    source: 'none',
    pro: false,
    signedIn: false,
    businessDomain: null,
  })),
}));
vi.mock('@/lib/quota', () => ({
  getAnonymizeStatus: vi.fn(async () =>
    anonRef.value
      ? { used: 1, remaining: 9, limit: 10, unlimited: false }
      : { used: 10, remaining: 0, limit: 10, unlimited: false },
  ),
  consumeAnonymize: vi.fn(async () => anonRef.value),
  formatQuotaReset: vi.fn(() => 'Sep 1'),
}));

const SECRET = 'sk-' + 'a'.repeat(30);

// Unit tests exercise the real computation without a browser worker. Separate
// host/client tests and Chromium tests cover thread, IPC, and timeout behavior.
vi.mock('@/lib/paste/client', () => ({ createPasteProcessor: vi.fn() }));
beforeEach(() => {
  vi.mocked(createPasteProcessor).mockReset();
  vi.mocked(createPasteProcessor).mockImplementation(async (signal) => {
    signal.throwIfAborted();
    const compute = createPasteComputation();
    return {
      async request(operation, input) {
        signal.throwIfAborted();
        return compute({ id: 1, operation, input } as PasteCommand) as never;
      },
    };
  });
});

// Real paste events expose composedPath() (target + ancestors); the guard reads it
// instead of e.target so shadow-DOM composers are reachable. Mirror that here.
function composedPathFrom(target: EventTarget | null): EventTarget[] {
  const path: EventTarget[] = [];
  let node = target as Node | null;
  while (node) {
    path.push(node);
    node = node.parentNode;
  }
  path.push(window);
  return path;
}

interface FakeCtx {
  addEventListener: (target: unknown, type: string, cb: (e: unknown) => unknown) => void;
}

function setup() {
  const handlers: Record<string, (e: unknown) => unknown> = {};
  const ctx: FakeCtx = {
    addEventListener: (_t, type, cb) => {
      handlers[type] = cb;
    },
  };
  const input = document.createElement('div');
  input.id = 'prompt-textarea';
  document.body.appendChild(input);

  const makeEvent = (text: string, target: EventTarget | null = input) => ({
    target,
    isTrusted: true,
    clipboardData: { getData: () => text },
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    composedPath: () => composedPathFrom(target),
  });

  return {
    input,
    start: () => createPasteGuard(ctx as never, { name: 'ChatGPT', siteKey: 'chatgpt' }),
    firePaste: (e: ReturnType<typeof makeEvent>) => handlers.paste?.(e),
    editInput: () => handlers.input?.({ composedPath: () => composedPathFrom(input) }),
    makeEvent,
  };
}

function lastOnAction(): (a: OverlayAction) => Promise<void> {
  return mountOverlayMock.mock.calls.at(-1)![1].onAction;
}

// Spy on sendTelemetry for the entire suite so prior tests' fingerprintsPromise resolutions
// don't bleed into the telemetry assertion test.
const sendTelemetrySpy = vi.spyOn(telemetryService, 'sendTelemetry').mockImplementation(() => {});

describe('createPasteGuard', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await acceptTerms(); // default: Terms already accepted (existing behavior tests)
    proRef.value = true; // default: pro unlocked
    anonRef.value = true; // default: anonymise allowed (quota available)
    mountOverlayMock.mockReset();
    mountOverlayMock.mockResolvedValue({ remove: vi.fn() });
    mountConsentGateMock.mockReset();
    mountConsentGateMock.mockResolvedValue({ remove: vi.fn() });
    document.execCommand = vi.fn(() => true);
    sendTelemetrySpy.mockClear();
    for (const key of Object.keys(window as unknown as Record<string, unknown>)) {
      if (key.startsWith('__secureintent')) {
        delete (window as unknown as Record<string, unknown>)[key];
      }
    }
  });
  afterEach(() => document.body.replaceChildren());

  test('live policy replacement cancels an old decision and blocks the next clean paste', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(SECRET));
    const oldAction = lastOnAction();
    const oldUi = await mountOverlayMock.mock.results.at(-1)!.value;
    await saveBundle({
      ...DEFAULT_BUNDLE,
      policy: {
        blockInsteadOfWarn: true,
        requireSessionLock: false,
        blockedSites: [location.hostname],
      },
    });
    await vi.waitFor(() => expect(oldUi.remove).toHaveBeenCalled());
    await oldAction('paste');
    expect(document.execCommand).not.toHaveBeenCalled();
    await t.firePaste(t.makeEvent('ordinary safe message'));
    expect(mountOverlayMock.mock.calls.at(-1)![1].policyBlock).toEqual({ host: location.hostname });
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  test('vault expiry is checked again in a long-lived page', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(SECRET));
    await lastOnAction()('redact');
    const inserted = vi.mocked(document.execCommand).mock.calls.at(-1)![2] as string;
    vi.mocked(document.execCommand).mockClear();
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 3_600_001);
    try {
      await t.firePaste(t.makeEvent(inserted));
      expect(document.execCommand).toHaveBeenLastCalledWith('insertText', false, inserted);
    } finally {
      clock.mockRestore();
    }
  });

  test('unconsented first paste shows the consent gate (not the warning); agreeing then warns', async () => {
    await consentItem.setValue(null); // Terms not yet accepted
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));

    // Consent gate shown; the actual secret warning is withheld until they agree.
    expect(mountConsentGateMock).toHaveBeenCalledTimes(1);
    expect(mountOverlayMock).not.toHaveBeenCalled();

    // Agree → consent recorded and the real warning now shows for this same paste.
    const gateProps = mountConsentGateMock.mock.calls[0][1] as {
      onAgree: () => void;
      onCancel: () => void;
    };
    gateProps.onAgree();
    await vi.waitFor(() => expect(mountOverlayMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await consentItem.getValue()).not.toBeNull());
  });

  test('unconsented paste that is then cancelled inserts nothing', async () => {
    await consentItem.setValue(null);
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));

    const gateProps = mountConsentGateMock.mock.calls[0][1] as { onCancel: () => void };
    gateProps.onCancel();
    expect(mountOverlayMock).not.toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(await consentItem.getValue()).toBeNull(); // still not accepted
  });

  test('a ChatGPT contenteditable that is not #prompt-textarea is still checked', async () => {
    const t = setup();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    await t.start();
    const ev = t.makeEvent('AKIAIOSFODNN7EXAMPLE', editor);
    await t.firePaste(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(mountOverlayMock).toHaveBeenCalled();
  });

  test('inserts a clean paste only after the worker scan completes', async () => {
    const t = setup();
    await t.start();
    const e = t.makeEvent('just a normal message');
    await t.firePaste(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledExactlyOnceWith(
      'insertText',
      false,
      'just a normal message',
    );
    expect(mountOverlayMock).not.toHaveBeenCalled();
  });

  test('blocks a paste containing a secret and shows the overlay', async () => {
    const t = setup();
    await t.start();
    const e = t.makeEvent(`here ${SECRET} end`);
    await t.firePaste(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(mountOverlayMock).toHaveBeenCalledTimes(1);
    expect(mountOverlayMock.mock.calls[0][1].site).toBe('ChatGPT');
    expect(mountOverlayMock.mock.calls[0][1].detections).toHaveLength(1);
  });

  test('worker startup failure stays blocked and dismissal allows a fresh checked paste', async () => {
    vi.mocked(createPasteProcessor).mockRejectedValueOnce(new Error('worker unavailable'));
    const t = setup();
    await t.start();
    const event = t.makeEvent(SECRET);
    await t.firePaste(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(mountOverlayMock).not.toHaveBeenCalled();
    expect(mountPasteStatusMock.mock.calls.at(-1)![1]).toBe('error');
    mountPasteStatusMock.mock.calls.at(-1)![2]();
    await t.firePaste(t.makeEvent(SECRET));
    expect(mountOverlayMock).toHaveBeenCalledTimes(1);
  });

  test('does not block when protection is disabled', async () => {
    await setEnabled(false);
    const t = setup();
    await t.start();
    const e = t.makeEvent(`here ${SECRET} end`);
    await t.firePaste(e);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(mountOverlayMock).not.toHaveBeenCalled();
  });

  test('records the number of secrets intercepted', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`${SECRET} and ${'ghp_' + 'b'.repeat(36)}`));

    // recordBlocked is fire-and-forget, so poll for the write to land.
    await vi.waitFor(async () => expect(await getBlockedCount()).toBe(2));
  });

  test('a second paste is cancelled while the warning remains open', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(SECRET));
    const second = t.makeEvent('sk-' + 'b'.repeat(30));
    await t.firePaste(second);
    expect(second.preventDefault).toHaveBeenCalled();
    expect(second.stopImmediatePropagation).toHaveBeenCalled();
    expect(mountOverlayMock).toHaveBeenCalledTimes(1);
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  test('the guard becomes busy before an asynchronous quota lookup', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getAnonymizeStatus>>) => void;
    vi.mocked(getAnonymizeStatus).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const t = setup();
    await t.start();
    const first = t.firePaste(t.makeEvent(SECRET));
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const second = t.makeEvent(SECRET);
    await t.firePaste(second);
    expect(second.preventDefault).toHaveBeenCalled();
    resolve({ used: 0, remaining: 10, limit: 10, unlimited: false });
    await first;
    expect(mountOverlayMock).toHaveBeenCalledTimes(1);
  });

  test('cancelled quota lookups cannot reopen the warning when they finish', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getAnonymizeStatus>>) => void;
    vi.mocked(getAnonymizeStatus).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const t = setup();
    await t.start();
    const first = t.firePaste(t.makeEvent(SECRET));
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    mountPasteStatusMock.mock.calls.at(-1)![2]();
    await first;
    resolve({ used: 0, remaining: 10, limit: 10, unlimited: false });
    await Promise.resolve();
    expect(mountOverlayMock).not.toHaveBeenCalled();
    await t.firePaste(t.makeEvent(SECRET));
    expect(mountOverlayMock).toHaveBeenCalledTimes(1);
  });

  test('a repeated action or a stale cancelled callback never inserts twice', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(SECRET));
    const old = lastOnAction();
    await old('cancel');
    await t.firePaste(t.makeEvent(SECRET));
    await old('paste');
    expect(document.execCommand).not.toHaveBeenCalled();
    const action = lastOnAction();
    await Promise.all([action('paste'), action('paste')]);
    expect(document.execCommand).toHaveBeenCalledTimes(1);
  });

  test('quota refusal at action time does not insert text', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(SECRET));
    vi.mocked(consumeAnonymize).mockResolvedValueOnce(false);
    await lastOnAction()('redact');
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(mountPasteStatusMock.mock.calls.at(-1)![1]).toBe('error');
  });

  test('a failed or expired transformation worker does not consume allowance', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(SECRET));
    const processor = await vi.mocked(createPasteProcessor).mock.results.at(-1)!.value;
    vi.spyOn(processor, 'request').mockRejectedValueOnce(new Error('worker expired'));
    vi.mocked(consumeAnonymize).mockClear();
    await lastOnAction()('redact');
    expect(consumeAnonymize).not.toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(mountPasteStatusMock.mock.calls.at(-1)![1]).toBe('error');
  });

  test('cancelling while the action status mounts does not consume quota', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(SECRET));
    vi.mocked(consumeAnonymize).mockClear();
    mountPasteStatusMock.mockImplementationOnce(async (_ctx, _status, cancel) => {
      cancel();
      return { remove: vi.fn() };
    });
    await lastOnAction()('redact');
    expect(consumeAnonymize).not.toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  test('editing while an action waits for quota cancels its eventual insertion', async () => {
    let resolve!: (allowed: boolean) => void;
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(SECRET));
    vi.mocked(consumeAnonymize).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const action = lastOnAction()('redact');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    t.editInput();
    resolve(true);
    await action;
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  test('untrusted editor re-inserts remain untouched even while a warning is open', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(SECRET));
    const synthetic = { ...t.makeEvent(SECRET), isTrusted: false };
    await t.firePaste(synthetic);
    expect(synthetic.preventDefault).not.toHaveBeenCalled();
  });

  test('oversized pastes are blocked with an explanation and can be dismissed', async () => {
    const t = setup();
    await t.start();
    const e = t.makeEvent('x'.repeat(MAX_PASTE_CHARS + 1));
    await t.firePaste(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(mountPasteStatusMock.mock.calls.at(-1)![1]).toBe('too-large');
    expect(mountOverlayMock).not.toHaveBeenCalled();
    mountPasteStatusMock.mock.calls.at(-1)![2]();
    const clean = t.makeEvent('ordinary text');
    await t.firePaste(clean);
    expect(clean.preventDefault).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'ordinary text');
  });

  test('cancelling a status while it mounts removes the late UI and never inserts', async () => {
    const remove = vi.fn();
    mountPasteStatusMock.mockImplementationOnce(async (_ctx, _status, cancel) => {
      cancel();
      return { remove, update: vi.fn() };
    });
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent('ordinary text '.repeat(10000)));
    expect(remove).toHaveBeenCalled();
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(mountOverlayMock).not.toHaveBeenCalled();
    await t.firePaste(t.makeEvent(SECRET));
    expect(mountOverlayMock).toHaveBeenCalledTimes(1);
  });

  test('a removed composer cannot receive an old warning action', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(SECRET));
    t.input.remove();
    await lastOnAction()('paste');
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  test('a worker-scanned large clean paste inserts once after checking', async () => {
    const t = setup();
    await t.start();
    const text = 'ordinary text '.repeat(Math.ceil(ASYNC_PASTE_CHARS / 14));
    const e = t.makeEvent(text);
    await t.firePaste(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledExactlyOnceWith('insertText', false, text);
  });

  test('ignores programmatic (untrusted) pastes to avoid re-insert loops', async () => {
    const t = setup();
    await t.start();
    const e = { ...t.makeEvent(`here ${SECRET} end`), isTrusted: false };
    await t.firePaste(e);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(mountOverlayMock).not.toHaveBeenCalled();
  });

  test('ignores pastes targeted outside the input', async () => {
    const t = setup();
    await t.start();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const e = t.makeEvent(`here ${SECRET} end`, outside);
    await t.firePaste(e);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(mountOverlayMock).not.toHaveBeenCalled();
  });

  test('"paste" action inserts the original text', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));
    await lastOnAction()('paste');

    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, `x ${SECRET} y`);
  });

  test('Slate editors (e.g. Discord) receive a synthetic paste, not execCommand', async () => {
    // jsdom can't construct DataTransfer/ClipboardEvent — provide Event-based fakes.
    class FakeDT {
      private d = '';
      setData(_t: string, v: string) {
        this.d = v;
      }
      getData() {
        return this.d;
      }
    }
    class FakeClipboardEvent extends Event {
      clipboardData: FakeDT | undefined;
      constructor(type: string, init?: { clipboardData?: FakeDT } & EventInit) {
        super(type, init);
        this.clipboardData = init?.clipboardData;
      }
    }
    vi.stubGlobal('DataTransfer', FakeDT);
    vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);

    const t = setup();
    t.input.setAttribute('data-slate-editor', 'true');
    let pasted: string | null = null;
    t.input.addEventListener('paste', (e) => {
      pasted = (e as unknown as FakeClipboardEvent).clipboardData?.getData() ?? '';
      e.preventDefault(); // Slate consumes the paste
    });

    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));
    (document.execCommand as ReturnType<typeof vi.fn>).mockClear();
    await lastOnAction()('paste');

    expect(pasted).toContain(SECRET);
    expect(document.execCommand).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('"redact" action inserts text with the secret removed', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));
    await lastOnAction()('redact');

    const inserted = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2];
    expect(inserted).not.toContain(SECRET);
    expect(inserted).toContain('x ');
  });

  test('free user with quota exhausted: overlay pro=false and "redact" is gated', async () => {
    proRef.value = false; // no ghost feature
    anonRef.value = false; // monthly anonymise quota used up
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));

    // Overlay renders the locked Pro state (upgrade prompt).
    expect(mountOverlayMock.mock.calls[0][1].pro).toBe(false);

    // Even if the (locked) action fires, the pro path does not run.
    await lastOnAction()('redact');
    const calls = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every((c) => !/⟦SI:[0-9a-f]{8}⟧/.test(String(c[2])))).toBe(true);
  });

  test('exhausted quota tells the overlay the allowance is spent, with its reset date', async () => {
    proRef.value = false;
    anonRef.value = false; // 0 of 10 left
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));

    expect(mountOverlayMock.mock.calls[0][1].quotaExhausted).toEqual({
      limit: 10,
      resetsOn: 'Sep 1',
    });
  });

  test('free user with quota left: overlay pro=true and "redact" anonymises', async () => {
    proRef.value = false; // no ghost feature
    anonRef.value = true; // free monthly quota available
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));
    expect(mountOverlayMock.mock.calls[0][1].pro).toBe(true);
    // Allowance remaining → no "you're out" messaging.
    expect(mountOverlayMock.mock.calls[0][1].quotaExhausted).toBeUndefined();
    await lastOnAction()('redact');
    const inserted = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2];
    expect(inserted).toMatch(/⟦SI:[0-9a-f]{8}⟧/);
  });

  test('"upgrade" action asks the background for the account page, not the tiers page', async () => {
    const sendMessage = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    proRef.value = false;
    anonRef.value = false;
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));

    await lastOnAction()('upgrade');
    expect(sendMessage).toHaveBeenCalledWith({ type: 'si-open-upgrade' });
    // Nothing is inserted: an upgrade click is not a paste.
    const calls = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every((c) => !String(c[2]).includes(SECRET))).toBe(true);
    sendMessage.mockRestore();
  });

  test('"redact" action inserts reversible SI tokens in place of the secret', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));
    await lastOnAction()('redact');

    const inserted = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2];
    expect(inserted).not.toContain(SECRET);
    expect(inserted).toMatch(/⟦SI:[0-9a-f]{8}⟧/);
  });

  // Dehydrate a secret, then paste its token back, returning the token string.
  async function dehydrateToken(t: ReturnType<typeof setup>): Promise<string> {
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));
    await lastOnAction()('redact'); // populates memVault synchronously
    const inserted = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2];
    return inserted.match(/⟦SI:[0-9a-f]{8}⟧/)![0];
  }

  test('rehydrate: pasting a token prompts, and "Rehydrate" restores the real secret', async () => {
    const t = setup();
    await t.start();
    const token = await dehydrateToken(t);

    const e = t.makeEvent(`const key = "${token}";`);
    await t.firePaste(e);
    expect(e.preventDefault).toHaveBeenCalled();
    // A rehydrate overlay is shown rather than swapping silently.
    expect(mountOverlayMock.mock.calls.at(-1)![1].rehydrate).toEqual({ tokenCount: 1 });

    await lastOnAction()('rehydrate');
    const out = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2];
    expect(out).toBe(`const key = "${SECRET}";`);
  });

  test('rehydrate: "Keep tokens" inserts the token text unchanged', async () => {
    const t = setup();
    await t.start();
    const token = await dehydrateToken(t);

    await t.firePaste(t.makeEvent(`const key = "${token}";`));
    await lastOnAction()('paste');
    const out = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2];
    expect(out).toBe(`const key = "${token}";`);
    expect(out).not.toContain(SECRET);
  });

  test('a mixed paste with known tokens and raw secrets still gets a secret warning', async () => {
    const t = setup();
    await t.start();
    const token = await dehydrateToken(t);
    const e = t.makeEvent(`${token} and ${SECRET}`);
    await t.firePaste(e);
    expect(e.preventDefault).toHaveBeenCalled();
    const props = mountOverlayMock.mock.calls.at(-1)![1];
    expect(props.rehydrate).toBeUndefined();
    expect(props.detections).toHaveLength(1);
  });

  test('rehydrate: "Cancel" drops the paste (nothing inserted)', async () => {
    const t = setup();
    await t.start();
    const token = await dehydrateToken(t);
    const insertsBefore = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls.length;

    await t.firePaste(t.makeEvent(`const key = "${token}";`));
    await lastOnAction()('cancel');
    expect((document.execCommand as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      insertsBefore,
    );
  });

  test('rehydrate: free user (no rehydrate feature) is not offered restore', async () => {
    const t = setup();
    await t.start();
    const token = await dehydrateToken(t); // dehydrate while allowed

    proRef.value = false; // free: the `rehydrate` feature is locked
    const overlaysBefore = mountOverlayMock.mock.calls.length;
    const insertsBefore = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls.length;

    const e = t.makeEvent(`const key = "${token}";`);
    await t.firePaste(e);

    // No rehydrate prompt: insert the checked tokens, never the original secret.
    expect(mountOverlayMock.mock.calls.length).toBe(overlaysBefore);
    expect(e.preventDefault).toHaveBeenCalled();
    expect((document.execCommand as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      insertsBefore + 1,
    );
    expect(document.execCommand).toHaveBeenLastCalledWith(
      'insertText',
      false,
      `const key = "${token}";`,
    );
  });

  test('rehydrate: pasting text without tokens is left untouched', async () => {
    const t = setup();
    await t.start();
    const e = t.makeEvent('just some normal pasted text');
    await t.firePaste(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledExactlyOnceWith(
      'insertText',
      false,
      'just some normal pasted text',
    );
  });

  test('large paste routes to Ghost: summary overlay, Sanitize & paste strips IPs/emails', async () => {
    const t = setup();
    await t.start();
    const filler = 'application log line number forty-two here '.repeat(60); // > 2000 chars
    const log = `${filler} host 10.0.0.5 contacted ops@corp.com ${filler}`;
    await t.firePaste(t.makeEvent(log));

    const props = mountOverlayMock.mock.calls.at(-1)![1];
    expect(props.summary).toBeTruthy();
    expect(props.summary.total).toBeGreaterThanOrEqual(2);

    await lastOnAction()('sanitize');
    const inserted = (document.execCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2];
    expect(inserted).not.toContain('10.0.0.5');
    expect(inserted).not.toContain('ops@corp.com');
    expect(inserted).toContain('[#IP_1#]');
    expect(inserted).toContain('[#EMAIL_1#]');
  });

  test('small paste uses the normal per-finding overlay (no Ghost summary)', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));

    const props = mountOverlayMock.mock.calls.at(-1)![1];
    expect(props.summary).toBeUndefined();
    expect(props.detections).toHaveLength(1);
  });

  test('large paste of only internal IPs (no keys) still triggers Ghost', async () => {
    const t = setup();
    await t.start();
    const log = `${'x'.repeat(2100)} 192.168.1.1`;
    await t.firePaste(t.makeEvent(log));

    const props = mountOverlayMock.mock.calls.at(-1)![1];
    expect(props.summary.total).toBe(1);
  });

  test('large benign paste with nothing sensitive passes through', async () => {
    const t = setup();
    await t.start();
    const e = t.makeEvent('lorem ipsum dolor sit amet '.repeat(120));
    await t.firePaste(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledExactlyOnceWith(
      'insertText',
      false,
      'lorem ipsum dolor sit amet '.repeat(120),
    );
    expect(mountOverlayMock).not.toHaveBeenCalled();
  });

  test('"cancel" action inserts nothing', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));
    await lastOnAction()('cancel');

    expect(document.execCommand).not.toHaveBeenCalled();
  });

  test('emits a telemetry event with paste_anonymously action and no raw secret on "redact"', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));

    await lastOnAction()('redact');

    const event = await vi.waitFor(() => {
      const call = sendTelemetrySpy.mock.calls.find(([e]) => e?.action === 'paste_anonymously');
      expect(call).toBeTruthy();
      return call![0];
    });

    expect(event.detections).toHaveLength(1);
    expect(event.detections[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(event.detections[0].label).toBe('OpenAI API key');
    expect(JSON.stringify(event)).not.toContain('sk-');
  });

  test('uses the bundle inputSelector for the site when present', async () => {
    // Seed the bundle with a custom selector for 'chatgpt'
    await saveBundle({ ...DEFAULT_BUNDLE, sites: { chatgpt: { inputSelector: '#custom-input' } } });

    // Build a harness that uses the bundle selector, not the fallback
    const handlers: Record<string, (e: unknown) => unknown> = {};
    const ctx = {
      addEventListener: (_t: unknown, type: string, cb: (e: unknown) => unknown) => {
        handlers[type] = cb;
      },
    };
    const customInput = document.createElement('div');
    customInput.id = 'custom-input';
    document.body.appendChild(customInput);

    await createPasteGuard(ctx as never, { name: 'ChatGPT', siteKey: 'chatgpt' });

    const e = {
      target: customInput,
      isTrusted: true,
      clipboardData: { getData: () => `here ${SECRET} end` },
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      composedPath: () => composedPathFrom(customInput),
    };
    await handlers.paste?.(e);

    // The guard should have matched the bundle's #custom-input and blocked the paste
    expect(e.preventDefault).toHaveBeenCalled();
    expect(mountOverlayMock).toHaveBeenCalledTimes(1);
  });

  test('comma-selector: paste into second field (body div) is blocked', async () => {
    const commaSelector = 'textarea[name="title"], div[contenteditable="true"][name="body"]';
    await saveBundle({ ...DEFAULT_BUNDLE, sites: { reddit: { inputSelector: commaSelector } } });

    const handlers: Record<string, (e: unknown) => unknown> = {};
    const ctx = {
      addEventListener: (_t: unknown, type: string, cb: (e: unknown) => unknown) => {
        handlers[type] = cb;
      },
    };

    const bodyDiv = document.createElement('div');
    bodyDiv.setAttribute('contenteditable', 'true');
    bodyDiv.setAttribute('name', 'body');
    document.body.appendChild(bodyDiv);

    await createPasteGuard(ctx as never, { name: 'Reddit', siteKey: 'reddit' });

    const e = {
      target: bodyDiv,
      isTrusted: true,
      clipboardData: { getData: () => `here ${SECRET} end` },
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      composedPath: () => composedPathFrom(bodyDiv),
    };
    await handlers.paste?.(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(mountOverlayMock).toHaveBeenCalledTimes(1);
  });

  test('does not block when killSwitch is active', async () => {
    await saveBundle({ ...DEFAULT_BUNDLE, killSwitch: true });

    const t = setup();
    await t.start();
    const e = t.makeEvent(`here ${SECRET} end`);
    await t.firePaste(e);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(mountOverlayMock).not.toHaveBeenCalled();
  });

  const HASH = 'd41d8cd98f00b204e9800998ecf8427e3bbce4dbca09a9e3aeb5c55a40a5a51a';

  test('aggressive (pilot) flags a high-entropy hash', async () => {
    await saveBundle({ ...DEFAULT_BUNDLE, aggressive: true });
    const t = setup();
    await t.start();
    const e = t.makeEvent(`hash ${HASH} end`);
    await t.firePaste(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  test('standard tuning (aggressive: false) does NOT flag the same hash', async () => {
    await saveBundle({ ...DEFAULT_BUNDLE, aggressive: false });
    const t = setup();
    await t.start();
    const e = t.makeEvent(`hash ${HASH} end`);
    await t.firePaste(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, `hash ${HASH} end`);
    expect(mountOverlayMock).not.toHaveBeenCalled();
  });

  test('an overlay failure keeps raw text blocked', async () => {
    // Arrange: make mountOverlay reject so the catch branch is exercised
    mountOverlayMock.mockRejectedValueOnce(new Error('mount boom'));

    const t = setup();
    await t.start();

    const text = `here ${SECRET} end`;
    const e = t.makeEvent(text);

    // Act: fire the paste and wait for the rejection to propagate through the async handler
    await t.firePaste(e);
    // The handler is async; give the microtask queue a tick to settle
    await new Promise((r) => setTimeout(r, 0));

    // The paste was intercepted (blocked) before the error
    expect(e.preventDefault).toHaveBeenCalled();

    expect(document.execCommand).not.toHaveBeenCalled();
    expect(mountPasteStatusMock).toHaveBeenLastCalledWith(
      expect.anything(),
      'error',
      expect.any(Function),
    );
  });
});

describe('createPasteGuard — team policy', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await acceptTerms();
    proRef.value = true;
    anonRef.value = true;
    mountOverlayMock.mockReset();
    mountOverlayMock.mockResolvedValue({ remove: vi.fn() });
    mountConsentGateMock.mockReset();
    mountConsentGateMock.mockResolvedValue({ remove: vi.fn() });
    document.execCommand = vi.fn(() => true);
    sendTelemetrySpy.mockClear();
    for (const key of Object.keys(window as unknown as Record<string, unknown>)) {
      if (key.startsWith('__secureintent')) {
        delete (window as unknown as Record<string, unknown>)[key];
      }
    }
  });
  afterEach(() => document.body.replaceChildren());

  // Only a signature-verified bundle is ever persisted (see configService), so
  // seeding the active bundle is exactly "the team pushed this policy".
  const savePolicy = (over: Partial<BundlePolicy>) =>
    saveBundle({
      ...DEFAULT_BUNDLE,
      policyVersion: 7,
      policy: {
        blockInsteadOfWarn: false,
        requireSessionLock: false,
        extraPatterns: [],
        blockedSites: [],
        ...over,
      },
    });

  const lastProps = () => mountOverlayMock.mock.calls.at(-1)![1];
  const inserts = () => (document.execCommand as ReturnType<typeof vi.fn>).mock.calls;

  test('regression: a bundle with NO policy behaves exactly as before', async () => {
    const t = setup();
    await t.start();
    const e = t.makeEvent(`x ${SECRET} y`);
    await t.firePaste(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(lastProps().policyBlock).toBeUndefined();
    expect(lastProps().blockRawPaste).toBe(false);

    await lastOnAction()('paste'); // "Paste anyway" still inserts the original text
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, `x ${SECRET} y`);
  });

  describe('blockInsteadOfWarn', () => {
    test('tokens cannot restore raw secrets under a raw-paste restriction', async () => {
      await savePolicy({ blockInsteadOfWarn: true });
      const t = setup();
      await t.start();
      await t.firePaste(t.makeEvent(SECRET));
      await lastOnAction()('redact');
      const token = inserts().at(-1)![2];
      mountOverlayMock.mockClear();
      (document.execCommand as ReturnType<typeof vi.fn>).mockClear();
      const e = t.makeEvent(token);
      await t.firePaste(e);
      expect(mountOverlayMock).not.toHaveBeenCalled();
      expect(document.execCommand).toHaveBeenCalledExactlyOnceWith('insertText', false, token);
      expect(e.preventDefault).toHaveBeenCalled(); // inert tokens insert after scanning
    });
    test('a second paste cannot bypass the team block', async () => {
      await savePolicy({ blockInsteadOfWarn: true });
      const t = setup();
      await t.start();
      await t.firePaste(t.makeEvent(SECRET));
      const second = t.makeEvent(SECRET);
      await t.firePaste(second);
      expect(second.preventDefault).toHaveBeenCalled();
      expect(second.stopImmediatePropagation).toHaveBeenCalled();
      expect(document.execCommand).not.toHaveBeenCalled();
    });
    test('the overlay is told not to offer "Paste anyway"', async () => {
      await savePolicy({ blockInsteadOfWarn: true });
      const t = setup();
      await t.start();
      await t.firePaste(t.makeEvent(`x ${SECRET} y`));

      expect(mountOverlayMock).toHaveBeenCalledTimes(1);
      expect(lastProps().blockRawPaste).toBe(true);
    });

    test('a "paste" outcome inserts nothing — the warning is a block', async () => {
      await savePolicy({ blockInsteadOfWarn: true });
      const t = setup();
      await t.start();
      await t.firePaste(t.makeEvent(`x ${SECRET} y`));

      await lastOnAction()('paste');
      expect(document.execCommand).not.toHaveBeenCalled();
    });

    test('a refused paste is reported as cancelled, never as paste_anyway', async () => {
      await savePolicy({ blockInsteadOfWarn: true });
      const t = setup();
      await t.start();
      await t.firePaste(t.makeEvent(`x ${SECRET} y`));

      await lastOnAction()('paste');
      const event = await vi.waitFor(() => {
        const call = sendTelemetrySpy.mock.calls.at(-1);
        expect(call).toBeTruthy();
        return call![0];
      });
      expect(event.action).toBe('cancelled');
      expect(event.policyVersion).toBe(7);
    });

    test('the anonymise path stays available', async () => {
      await savePolicy({ blockInsteadOfWarn: true });
      const t = setup();
      await t.start();
      await t.firePaste(t.makeEvent(`x ${SECRET} y`));

      await lastOnAction()('redact');
      const inserted = inserts().at(-1)![2];
      expect(inserted).not.toContain(SECRET);
      expect(inserted).toMatch(/⟦SI:[0-9a-f]{8}⟧/);
    });

    test('an overlay failure drops the paste instead of re-inserting the raw text', async () => {
      // Fail-open must not become the leak the policy exists to prevent: the
      // page keeps working, only this paste is dropped.
      await savePolicy({ blockInsteadOfWarn: true });
      mountOverlayMock.mockRejectedValueOnce(new Error('mount boom'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const t = setup();
      await t.start();
      const e = t.makeEvent(`x ${SECRET} y`);
      await t.firePaste(e);
      await new Promise((r) => setTimeout(r, 0));

      expect(e.preventDefault).toHaveBeenCalled();
      expect(document.execCommand).not.toHaveBeenCalled();
    });
  });

  describe('blockedSites', () => {
    test('a paste with a detection is blocked outright with a policy notice', async () => {
      await savePolicy({ blockedSites: [location.hostname] });
      const t = setup();
      await t.start();
      const e = t.makeEvent(`x ${SECRET} y`);
      await t.firePaste(e);

      expect(e.preventDefault).toHaveBeenCalled();
      expect(lastProps().policyBlock).toEqual({ host: location.hostname });

      // No outcome inserts anything here — not even the (absent) paste action.
      await lastOnAction()('paste');
      await lastOnAction()('cancel');
      expect(document.execCommand).not.toHaveBeenCalled();
    });

    test('a large (Ghost) paste is blocked too, with no sanitize escape hatch', async () => {
      await savePolicy({ blockedSites: [location.hostname] });
      const t = setup();
      await t.start();
      const filler = 'application log line number forty-two here '.repeat(60);
      await t.firePaste(t.makeEvent(`${filler} host 10.0.0.5 contacted ops@corp.com ${filler}`));

      // The block notice replaces the Ghost summary — no paste, no sanitize.
      expect(lastProps().policyBlock).toEqual({ host: location.hostname });
      await lastOnAction()('sanitize');
      await lastOnAction()('paste');
      expect(document.execCommand).not.toHaveBeenCalled();
    });

    // The rule is about the SITE, not the secret. The console tells the admin
    // "the extension refuses every paste, whether or not it finds a secret", so
    // a clean paste has to be stopped too — otherwise the rule quietly means
    // something narrower than what they were sold.
    test('a clean paste is refused too — the rule is about the destination', async () => {
      await savePolicy({ blockedSites: [location.hostname] });
      const t = setup();
      await t.start();
      const e = t.makeEvent('just a normal message');
      await t.firePaste(e);

      expect(e.preventDefault).toHaveBeenCalled();
      expect(lastProps().policyBlock).toEqual({ host: location.hostname });
      expect(document.execCommand).not.toHaveBeenCalled();
    });

    test('and reports nothing, because no secret was found to report', async () => {
      await savePolicy({ blockedSites: [location.hostname] });
      sendTelemetrySpy.mockClear();
      const t = setup();
      await t.start();
      await t.firePaste(t.makeEvent('just a normal message'));
      await Promise.resolve();

      expect(sendTelemetrySpy).not.toHaveBeenCalled();
    });

    test('a host that is NOT on the list gets the ordinary warning', async () => {
      await savePolicy({ blockedSites: ['pastebin.com'] });
      const t = setup();
      await t.start();
      await t.firePaste(t.makeEvent(`x ${SECRET} y`));

      expect(lastProps().policyBlock).toBeUndefined();
      await lastOnAction()('paste');
      expect(document.execCommand).toHaveBeenCalledWith('insertText', false, `x ${SECRET} y`);
    });

    test('rehydrate is not offered on a blocked host (it would restore a secret)', async () => {
      // Dehydrate on an unblocked page first, then re-run the guard under the block.
      const t = setup();
      await t.start();
      await t.firePaste(t.makeEvent(`x ${SECRET} y`));
      await lastOnAction()('redact');
      const token = inserts()
        .at(-1)![2]
        .match(/⟦SI:[0-9a-f]{8}⟧/)![0];

      await savePolicy({ blockedSites: [location.hostname] });
      delete (window as unknown as Record<string, unknown>).__secureintentStarted_chatgpt__;
      const t2 = setup();
      await t2.start();
      mountOverlayMock.mockClear();
      (document.execCommand as ReturnType<typeof vi.fn>).mockClear();

      const e = t2.makeEvent(`const key = "${token}";`);
      await t2.firePaste(e);

      // The blocked destination stops it like any other paste, and crucially the
      // real secret is never restored — the token stays inert.
      expect(e.preventDefault).toHaveBeenCalled();
      expect(lastProps().policyBlock).toEqual({ host: location.hostname });
      expect(document.execCommand).not.toHaveBeenCalled();
    });
  });
});

/**
 * A team admin's own patterns ride in on the same signed bundle and run through
 * the same detection path as ours. These pin the whole plumb: bundle → compile →
 * detect → the props the warning overlay is handed.
 */
describe('createPasteGuard — team patterns (origin)', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await acceptTerms();
    proRef.value = true;
    anonRef.value = true;
    mountOverlayMock.mockReset();
    mountOverlayMock.mockResolvedValue({ remove: vi.fn() });
    mountConsentGateMock.mockReset();
    mountConsentGateMock.mockResolvedValue({ remove: vi.fn() });
    document.execCommand = vi.fn(() => true);
    sendTelemetrySpy.mockClear();
    for (const key of Object.keys(window as unknown as Record<string, unknown>)) {
      if (key.startsWith('__secureintent')) {
        delete (window as unknown as Record<string, unknown>)[key];
      }
    }
  });
  afterEach(() => document.body.replaceChildren());

  const TEAM_SECRET = 'ACME-4F2K9Z7Q1B3D';
  // Exactly what /v1/config serves a team member: the catalogue plus their own
  // patterns, and only the team's carry `origin`.
  const saveTeamPatterns = () =>
    saveBundle({
      ...DEFAULT_BUNDLE,
      patterns: [
        ...DEFAULT_BUNDLE.patterns,
        {
          type: 'known-key',
          label: 'Acme internal token',
          regex: 'ACME-[A-Z0-9]{12}',
          origin: 'team',
        },
      ],
    });

  const lastProps = () => mountOverlayMock.mock.calls.at(-1)![1];

  test("a team pattern blocks the paste and the finding is marked 'team'", async () => {
    await saveTeamPatterns();
    const t = setup();
    await t.start();
    const e = t.makeEvent(`deploy ${TEAM_SECRET} now`);
    await t.firePaste(e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(lastProps().detections).toHaveLength(1);
    expect(lastProps().detections[0]).toMatchObject({
      label: 'Acme internal token',
      origin: 'team',
    });
  });

  test('the default catalogue still detects alongside it, with no origin', async () => {
    await saveTeamPatterns();
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y and ${TEAM_SECRET} z`));

    const dets = lastProps().detections;
    expect(dets).toHaveLength(2);
    expect(dets.map((d: { origin?: string }) => d.origin)).toEqual([undefined, 'team']);
  });

  test('regression: with no team patterns the overlay sees findings with no origin', async () => {
    const t = setup();
    await t.start();
    await t.firePaste(t.makeEvent(`x ${SECRET} y`));

    const dets = lastProps().detections;
    expect(dets).toHaveLength(1);
    expect('origin' in dets[0]).toBe(false);
  });
});

describe('fallback guard (catch-all)', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await acceptTerms(); // default: Terms already accepted (existing behavior tests)
    proRef.value = true; // default: pro unlocked
    anonRef.value = true; // default: anonymise allowed (quota available)
    mountOverlayMock.mockReset();
    mountOverlayMock.mockResolvedValue({ remove: vi.fn() });
    mountConsentGateMock.mockReset();
    mountConsentGateMock.mockResolvedValue({ remove: vi.fn() });
    document.execCommand = vi.fn(() => true);
    for (const key of Object.keys(window as unknown as Record<string, unknown>)) {
      if (key.startsWith('__secureintent')) {
        delete (window as unknown as Record<string, unknown>)[key];
      }
    }
  });
  afterEach(() => document.body.replaceChildren());

  function setupFallback() {
    const handlers: Record<string, (e: unknown) => unknown> = {};
    const ctx = {
      addEventListener: (_t: unknown, type: string, cb: (e: unknown) => unknown) => {
        handlers[type] = cb;
      },
    };
    const input = document.createElement('textarea'); // matches the generic fallback selector
    document.body.appendChild(input);
    const e = {
      target: input,
      isTrusted: true,
      clipboardData: { getData: () => `here ${SECRET} end` },
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      composedPath: () => composedPathFrom(input),
    };
    return {
      e,
      start: () => createPasteGuard(ctx as never, { name: 'example.com', siteKey: 'fallback' }),
      firePaste: () => handlers.paste?.(e),
    };
  }

  test('blocks a secret on an unsupported site (no dedicated guard present)', async () => {
    const t = setupFallback();
    await t.start();
    await t.firePaste();
    expect(t.e.preventDefault).toHaveBeenCalled();
    expect(mountOverlayMock).toHaveBeenCalledTimes(1);
  });

  test('bails when a dedicated guard already owns the page', async () => {
    // a dedicated (non-fallback) guard marks the shared window flag synchronously
    (window as unknown as Record<string, boolean>).__secureintentDedicated__ = true;
    const t = setupFallback();
    await t.start();
    await t.firePaste();
    expect(t.e.preventDefault).not.toHaveBeenCalled();
    expect(mountOverlayMock).not.toHaveBeenCalled();
  });
});
