import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getActiveBundle } from '@/lib/config';
import { DEFAULT_BUNDLE } from '@/lib/config/default';
import { configItem } from '@/lib/config/store';
import { acceptTerms, consentItem } from '@/lib/consent';
import { entitlementItem } from '@/lib/entitlement/store';
import { createPasteProcessor } from '@/lib/paste/client';
import { createPasteComputation } from '@/lib/paste/process';
import type { PasteCommand, PasteOperations, PasteProcessor } from '@/lib/paste/protocol';
import { mountConsentGate } from '@/overlay/mountConsentGate';
import { enabledItem, isEnabled } from '@/settings';
import { checkFiles, installFileGuard } from './fileGuard';

vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return { ...actual, getActiveBundle: vi.fn() };
});
vi.mock('@/lib/paste/client', () => ({ createPasteProcessor: vi.fn() }));
vi.mock('@/overlay/mountConsentGate', () => ({ mountConsentGate: vi.fn() }));
vi.mock('@/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/settings')>()),
  isEnabled: vi.fn(),
}));

let invalidate: (() => void) | undefined;

function file(name: string, content: string): File {
  return {
    name,
    type: 'application/json',
    size: content.length,
    text: vi.fn(async () => content),
  } as unknown as File;
}

beforeEach(async () => {
  fakeBrowser.reset();
  await acceptTerms();
  vi.mocked(createPasteProcessor).mockReset();
  vi.mocked(mountConsentGate).mockReset();
  vi.mocked(mountConsentGate).mockResolvedValue({ remove: vi.fn() });
  vi.mocked(getActiveBundle).mockResolvedValue(DEFAULT_BUNDLE);
  vi.mocked(isEnabled).mockResolvedValue(true);
  vi.mocked(createPasteProcessor).mockImplementation(async () => {
    const compute = createPasteComputation();
    return {
      request: async (operation: keyof PasteOperations, input: unknown) =>
        compute({ id: 1, operation, input } as PasteCommand),
    } as PasteProcessor;
  });
});

afterEach(() => {
  invalidate?.();
  invalidate = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('respects the extension off switch and remote kill switch', async () => {
  const upload = file(
    'settings.json',
    '{"apiKey":"SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3"}',
  );
  vi.mocked(isEnabled).mockResolvedValue(false);
  expect(await checkFiles([upload], 'chatgpt.com')).toMatchObject({ kind: 'clean' });
  vi.mocked(isEnabled).mockResolvedValue(true);
  vi.mocked(getActiveBundle).mockResolvedValue({ ...DEFAULT_BUNDLE, killSwitch: true });
  expect(await checkFiles([upload], 'chatgpt.com')).toMatchObject({ kind: 'clean' });
  expect(upload.text).not.toHaveBeenCalled();
});

test('scans an unknown JSON key locally and warns before allowing upload', async () => {
  const value = 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3';
  const upload = file('settings.json', JSON.stringify({ nested: { apiKey: value } }));
  const result = await checkFiles([upload], 'chatgpt.com');
  expect(result).toMatchObject({ kind: 'warning', count: 1 });
  expect(createPasteProcessor).toHaveBeenCalledTimes(1);
});

test('Business policy blocks a sensitive file and a blocked destination', async () => {
  vi.mocked(getActiveBundle).mockResolvedValue({
    ...DEFAULT_BUNDLE,
    policy: {
      blockInsteadOfWarn: true,
      requireSessionLock: false,
      blockedSites: ['blocked.example'],
    },
  });
  const upload = file(
    'settings.json',
    JSON.stringify({ apiKey: 'SYNTHETIC.DETECTOR.TOKEN.9Z7x6W5v4U3t2S1r8Q0p6N3' }),
  );
  expect(await checkFiles([upload], 'chatgpt.com')).toMatchObject({ kind: 'blocked', count: 1 });
  expect(await checkFiles([upload], 'blocked.example')).toMatchObject({
    kind: 'blocked',
    count: 0,
  });
  expect(upload.text).toHaveBeenCalledTimes(1);
});

test('Business custom patterns are applied to files', async () => {
  vi.mocked(getActiveBundle).mockResolvedValue({
    ...DEFAULT_BUNDLE,
    patterns: [
      { type: 'known-key', label: 'Company key', regex: 'ACME-[A-Z0-9]{12}', origin: 'team' },
    ],
    policy: { blockInsteadOfWarn: true, requireSessionLock: false, blockedSites: [] },
  });
  expect(
    await checkFiles([file('settings.json', '{"key":"ACME-ABCDEF123456"}')], 'chatgpt.com'),
  ).toMatchObject({ kind: 'blocked', count: 1 });
});

test('oversized files fail closed before reading content', async () => {
  const upload = file('settings.json', '{}');
  Object.defineProperty(upload, 'size', { value: 4_000_001 });
  expect(await checkFiles([upload], 'chatgpt.com')).toMatchObject({ kind: 'error' });
  expect(upload.text).not.toHaveBeenCalled();
});

test('aggregate size limit rejects a large multi-file selection', async () => {
  const files = ['a.json', 'b.json', 'c.json'].map((name) => file(name, '{}'));
  for (const upload of files) Object.defineProperty(upload, 'size', { value: 3_000_000 });
  expect(await checkFiles(files, 'chatgpt.com')).toMatchObject({ kind: 'error' });
  for (const upload of files) expect(upload.text).not.toHaveBeenCalled();
});

test('Shadow destination rules apply to file uploads as well as pastes', async () => {
  const rules = {
    blockInsteadOfWarn: false,
    requireSessionLock: false,
    blockedSites: [],
    aiServices: [
      { serviceId: 'chatgpt', classification: 'review' as const, pasteMode: 'block_all' as const },
    ],
  };
  vi.mocked(getActiveBundle).mockResolvedValue({ ...DEFAULT_BUNDLE, policy: rules });
  const clean = file('notes.txt', 'ordinary text');
  expect(await checkFiles([clean], 'chatgpt.com')).toMatchObject({ kind: 'blocked' });
  expect(clean.text).not.toHaveBeenCalled();
  vi.mocked(getActiveBundle).mockResolvedValue({
    ...DEFAULT_BUNDLE,
    policy: { ...rules, aiServices: [{ ...rules.aiServices[0], pasteMode: 'block_sensitive' }] },
  });
  expect(await checkFiles([clean], 'chatgpt.com')).toMatchObject({ kind: 'clean' });
  expect(
    await checkFiles([file('notes.txt', 'contact=alice@example.com')], 'chatgpt.com'),
  ).toMatchObject({ kind: 'blocked', count: 1 });
});

function install() {
  // jsdom has no DataTransfer. Keep file assignment and event propagation real,
  // with only the browser's FileList construction represented by an array.
  vi.stubGlobal(
    'DataTransfer',
    class {
      files: File[] = [];
      items = { add: (upload: File) => this.files.push(upload) };
    },
  );
  vi.stubGlobal(
    'DragEvent',
    class extends Event {
      dataTransfer: DataTransfer | null;
      constructor(type: string, options: DragEventInit) {
        super(type, options);
        this.dataTransfer = options.dataTransfer ?? null;
      }
    },
  );
  installFileGuard({
    onInvalidated: (callback: () => void) => {
      invalidate = callback;
    },
  } as never);
}

function fileInput(parent: ParentNode = document.body) {
  const input = document.createElement('input');
  input.type = 'file';
  let selected: File[] = [];
  Object.defineProperty(input, 'files', {
    get: () => selected,
    set: (value: File[]) => {
      selected = Array.from(value);
    },
  });
  Object.defineProperty(input, 'value', {
    get: () => (selected.length ? `C:\\fakepath\\${selected[0].name}` : ''),
    set: () => {
      selected = [];
    },
  });
  parent.append(input);
  return input;
}

function select(input: HTMLInputElement, files: File[]) {
  input.files = files as unknown as FileList;
  const event = new Event('input', { bubbles: true, composed: true, cancelable: true });
  input.dispatchEvent(event);
  // Native file-input changes do not have to cross a shadow boundary.
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return event;
}

function textFile(name = 'notes.txt', text = 'ordinary meeting notes') {
  return new File([text], name, { type: 'text/plain' });
}

function deferScan() {
  let resolve!: (value: { total: number }) => void;
  const promise = new Promise<{ total: number }>((done) => {
    resolve = done;
  });
  const request = vi.fn(() => promise);
  vi.mocked(createPasteProcessor).mockResolvedValueOnce({ request } as unknown as PasteProcessor);
  return { request, resolve };
}

test('checks shadow-root file inputs before inner or outer page handlers receive the file', async () => {
  install();
  const host = document.createElement('upload-widget');
  document.body.append(host);
  const input = fileInput(host.attachShadow({ mode: 'open' }));
  const received: string[] = [];
  input.addEventListener('change', () => received.push(input.files?.[0]?.name ?? 'empty'));
  const scan = deferScan();
  const event = select(input, [textFile()]);
  expect(event.defaultPrevented).toBe(true);
  expect(received).toEqual([]);
  await vi.waitFor(() => expect(scan.request).toHaveBeenCalledOnce());
  expect(received).toEqual([]);
  scan.resolve({ total: 0 });
  await vi.waitFor(() => expect(received).toEqual(['notes.txt']));
});

test('a newer file selection cancels the old scan and only the new file is replayed', async () => {
  install();
  const input = fileInput();
  const received: string[] = [];
  input.addEventListener('change', () => received.push(input.files?.[0]?.name ?? 'empty'));
  const scan = deferScan();
  select(input, [textFile('old.txt')]);
  await vi.waitFor(() => expect(scan.request).toHaveBeenCalledOnce());
  const oldSignal = vi.mocked(createPasteProcessor).mock.calls[0][0];
  select(input, [textFile('new.txt')]);
  expect(oldSignal.aborted).toBe(true);
  await vi.waitFor(() => expect(received).toEqual(['new.txt']));
  scan.resolve({ total: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toEqual(['new.txt']);
  expect(input.files?.[0]?.name).toBe('new.txt');
});

test('same-document navigation during scanning cannot replay a file under the previous route policy', async () => {
  const originalUrl = location.href;
  install();
  const input = fileInput();
  const received = vi.fn();
  input.addEventListener('change', received);
  const scan = deferScan();
  select(input, [textFile()]);
  await vi.waitFor(() => expect(scan.request).toHaveBeenCalledOnce());
  try {
    history.pushState({}, '', '/copilot');
    scan.resolve({ total: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).not.toHaveBeenCalled();
    expect(input.files).toHaveLength(0);
    expect(document.querySelector('secureintent-file-check')).toBeNull();
  } finally {
    history.replaceState({}, '', originalUrl);
  }
});

test.each([
  'reset',
  'empty selection',
  'picker cancel',
  'escape',
  'policy',
  'identity',
  'disable',
  'consent',
  'invalidation',
] as const)('%s cancels pending file work without replay', async (cause) => {
  install();
  const form = document.createElement('form');
  document.body.append(form);
  const input = fileInput(form);
  const received: string[] = [];
  input.addEventListener('change', () => {
    if (input.files?.length) received.push(input.files[0].name);
  });
  const scan = deferScan();
  select(input, [textFile()]);
  await vi.waitFor(() => expect(scan.request).toHaveBeenCalledOnce());
  const signal = vi.mocked(createPasteProcessor).mock.calls[0][0];
  switch (cause) {
    case 'reset':
      form.reset();
      break;
    case 'empty selection':
      select(input, []);
      break;
    case 'picker cancel':
      input.dispatchEvent(new Event('cancel'));
      break;
    case 'escape':
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      break;
    case 'policy':
      await configItem.setValue({ ...DEFAULT_BUNDLE, policyVersion: 2 });
      break;
    case 'identity':
      await entitlementItem.setValue({ blob: { clerkUserId: 'another-user' } } as never);
      break;
    case 'disable':
      await enabledItem.setValue(false);
      break;
    case 'consent':
      await consentItem.setValue(null);
      break;
    case 'invalidation':
      invalidate?.();
      invalidate = undefined;
      break;
  }
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  scan.resolve({ total: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toEqual([]);
});

test.each([
  'reset',
  'replacement',
  'policy',
  'navigation',
] as const)('%s removes a pending file warning and disables its old action', async (cause) => {
  install();
  const attachShadow = HTMLElement.prototype.attachShadow;
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (
    this: HTMLElement,
    options,
  ) {
    return attachShadow.call(this, { ...options, mode: 'open' });
  });
  const form = document.createElement('form');
  document.body.append(form);
  const input = fileInput(form);
  const received: string[] = [];
  input.addEventListener('change', () => received.push(input.files?.[0]?.name ?? 'empty'));
  select(input, [textFile('old.txt', 'password: CorrectHorseBatteryStaple')]);
  await vi.waitFor(() => expect(document.querySelector('secureintent-file-check')).not.toBeNull());
  const warning = document.querySelector('secureintent-file-check')!;
  const oldAllow = Array.from(warning.shadowRoot!.querySelectorAll('button')).find(
    (button) => button.textContent === 'Upload anyway',
  )!;
  const originalUrl = location.href;
  try {
    if (cause === 'reset') form.reset();
    if (cause === 'replacement') select(input, [textFile('new.txt')]);
    if (cause === 'policy') await configItem.setValue({ ...DEFAULT_BUNDLE, policyVersion: 2 });
    if (cause === 'navigation') {
      history.pushState({}, '', '/copilot');
      oldAllow.click();
    }
    await vi.waitFor(() => expect(warning.isConnected).toBe(false));
    oldAllow.click();
    if (cause === 'replacement') await vi.waitFor(() => expect(received).toEqual(['new.txt']));
    else {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(received).toEqual([]);
    }
  } finally {
    history.replaceState({}, '', originalUrl);
  }
});

test('a newer drop cancels the pending drop before either can replay out of order', async () => {
  install();
  const target = document.createElement('div');
  document.body.append(target);
  const received: string[] = [];
  target.addEventListener('drop', (event) => received.push(event.dataTransfer!.files[0].name));
  const drop = (name: string) => {
    const transfer = new DataTransfer();
    transfer.items.add(textFile(name));
    target.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  };
  const scan = deferScan();
  drop('old.txt');
  await vi.waitFor(() => expect(scan.request).toHaveBeenCalledOnce());
  const signal = vi.mocked(createPasteProcessor).mock.calls[0][0];
  drop('new.txt');
  expect(signal.aborted).toBe(true);
  await vi.waitFor(() => expect(received).toEqual(['new.txt']));
  scan.resolve({ total: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(received).toEqual(['new.txt']);
});

test('cancels a pending FileReader when its selection is replaced', async () => {
  install();
  const readers: FileReader[] = [];
  vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
    readers.push(this);
  });
  const abort = vi.spyOn(FileReader.prototype, 'abort');
  const input = fileInput();
  select(input, [textFile()]);
  await vi.waitFor(() => expect(readers).toHaveLength(1));
  select(input, []);
  expect(abort).toHaveBeenCalledOnce();
  expect(createPasteProcessor).not.toHaveBeenCalled();
});

test('cancellation during consent initialization cannot mount an orphan consent dialog', async () => {
  await consentItem.setValue(null);
  install();
  let resolve!: (bundle: typeof DEFAULT_BUNDLE) => void;
  vi.mocked(getActiveBundle).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const input = fileInput();
  select(input, [textFile()]);
  select(input, []);
  resolve(DEFAULT_BUNDLE);
  await new Promise((done) => setTimeout(done, 0));
  expect(mountConsentGate).not.toHaveBeenCalled();
  expect(createPasteProcessor).not.toHaveBeenCalled();
});

test('replacing a consent-gated selection cancels its gate and accepts consent for the new file', async () => {
  await consentItem.setValue(null);
  install();
  const input = fileInput();
  const received: string[] = [];
  input.addEventListener('change', () => received.push(input.files?.[0]?.name ?? 'empty'));
  select(input, [textFile('old.txt')]);
  await vi.waitFor(() => expect(mountConsentGate).toHaveBeenCalledOnce());
  const oldGate = await vi.mocked(mountConsentGate).mock.results[0].value;
  select(input, [textFile('new.txt')]);
  await vi.waitFor(() => expect(mountConsentGate).toHaveBeenCalledTimes(2));
  expect(oldGate.remove).toHaveBeenCalled();
  vi.mocked(mountConsentGate).mock.calls[0][1].onAgree();
  expect(createPasteProcessor).not.toHaveBeenCalled();
  vi.mocked(mountConsentGate).mock.calls[1][1].onAgree();
  await vi.waitFor(() => expect(received).toEqual(['new.txt']));
});

test('bounds simultaneous file checks without reading or replaying an excess selection', async () => {
  install();
  const scans = Array.from({ length: 4 }, () => deferScan());
  for (let index = 0; index < 4; index++) select(fileInput(), [textFile(`pending-${index}.txt`)]);
  await vi.waitFor(() => expect(createPasteProcessor).toHaveBeenCalledTimes(4));
  const excess = fileInput();
  const received = vi.fn();
  excess.addEventListener('change', received);
  select(excess, [textFile('excess.txt')]);
  expect(document.querySelector('secureintent-file-check')).not.toBeNull();
  expect(excess.files).toHaveLength(0);
  expect(received).not.toHaveBeenCalled();
  expect(createPasteProcessor).toHaveBeenCalledTimes(4);
  for (const scan of scans) scan.resolve({ total: 0 });
});

test('bounds pending text bytes across separate file inputs', async () => {
  install();
  const scan = deferScan();
  const first = textFile();
  Object.defineProperty(first, 'size', { value: 4_000_000 });
  select(fileInput(), [first, first]);
  await vi.waitFor(() => expect(scan.request).toHaveBeenCalledOnce());
  const excess = fileInput();
  select(excess, [textFile()]);
  expect(document.querySelector('secureintent-file-check')).not.toBeNull();
  expect(excess.files).toHaveLength(0);
  expect(createPasteProcessor).toHaveBeenCalledOnce();
});
