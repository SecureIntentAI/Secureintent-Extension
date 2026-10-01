import { beforeEach, expect, test, vi } from 'vitest';
import { getActiveBundle } from '@/lib/config';
import { DEFAULT_BUNDLE } from '@/lib/config/default';
import { createPasteProcessor } from '@/lib/paste/client';
import { createPasteComputation } from '@/lib/paste/process';
import type { PasteCommand, PasteOperations, PasteProcessor } from '@/lib/paste/protocol';
import { isEnabled } from '@/settings';
import { checkFiles } from './fileGuard';

vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return { ...actual, getActiveBundle: vi.fn() };
});
vi.mock('@/lib/paste/client', () => ({ createPasteProcessor: vi.fn() }));
vi.mock('@/settings', () => ({ isEnabled: vi.fn() }));

function file(name: string, content: string): File {
  return {
    name,
    type: 'application/json',
    size: content.length,
    text: vi.fn(async () => content),
  } as unknown as File;
}

beforeEach(() => {
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

test('Shadow destination rules apply to file uploads as well as pastes',async()=>{
  const rules = {blockInsteadOfWarn:false,requireSessionLock:false,blockedSites:[],aiServices:[{serviceId:'chatgpt',classification:'review' as const,pasteMode:'block_all' as const}]};
  vi.mocked(getActiveBundle).mockResolvedValue({...DEFAULT_BUNDLE,policy:rules});
  const clean=file('notes.txt','ordinary text');
  expect(await checkFiles([clean],'chatgpt.com')).toMatchObject({kind:'blocked'});
  expect(clean.text).not.toHaveBeenCalled();
  vi.mocked(getActiveBundle).mockResolvedValue({...DEFAULT_BUNDLE,policy:{...rules,aiServices:[{...rules.aiServices[0],pasteMode:'block_sensitive'}]}});
  expect(await checkFiles([clean],'chatgpt.com')).toMatchObject({kind:'clean'});
  expect(await checkFiles([file('notes.txt','contact=alice@example.com')],'chatgpt.com')).toMatchObject({kind:'blocked',count:1});
});
