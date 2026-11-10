import { afterEach, describe, expect, test, vi } from 'vitest';
import { elapsedMs, siDebug, siError } from './index';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('siDebug', () => {
  test('formats as "[SecureIntent] <site> · <event>" with data', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    siDebug('Claude', 'paste blocked', { secrets: 2 });
    expect(spy).toHaveBeenCalledWith('[SecureIntent] Claude · paste blocked', { secrets: 2 });
  });

  test('omits the data argument when none is given', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    siDebug('Gemini', 'guard active');
    expect(spy).toHaveBeenCalledWith('[SecureIntent] Gemini · guard active');
  });

  test('writes nothing outside a development build', () => {
    vi.stubEnv('DEV', false);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    siDebug('Claude', 'paste blocked', { secrets: 2 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('siError', () => {
  test('routes through console.error with the same prefix shape', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('boom');
    siError('Perplexity', 'paste guard error', err);
    expect(spy).toHaveBeenCalledWith('[SecureIntent] Perplexity · paste guard error', err);
  });
});

describe('elapsedMs', () => {
  test('returns a non-negative number rounded to one decimal', () => {
    const ms = elapsedMs(performance.now());
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(ms)).toBe(true);
    expect(Math.round(ms * 10) / 10).toBe(ms);
  });
});
