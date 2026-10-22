import { expect, test } from 'vitest';
import { frameHostname } from './frame';

const ancestors = (...origins: string[]) =>
  Object.assign([...origins], {
    contains: (s: string) => origins.includes(s),
    item: (i: number) => origins[i] ?? null,
  }) as unknown as DOMStringList;

test('a frame with its own address uses its own host', () => {
  expect(frameHostname({ hostname: 'editor.example' }, 'https://editor.example')).toBe(
    'editor.example',
  );
});

test('about:blank and srcdoc frames use the origin they inherit', () => {
  expect(frameHostname({ hostname: '' }, 'https://chat.example')).toBe('chat.example');
});

test('an opaque frame falls back to the frame that embeds it', () => {
  expect(
    frameHostname({ hostname: '', ancestorOrigins: ancestors('https://host.example') }, 'null'),
  ).toBe('host.example');
  expect(frameHostname({ hostname: '' }, 'null')).toBe('');
});
