import { describe, expect, test } from 'vitest';
import { scriptsForUrl } from './openTabs';

describe('scriptsForUrl', () => {
  test('an open ChatGPT tab gets the ChatGPT guard before the catch-all', () => {
    expect(scriptsForUrl('https://chatgpt.com/c/abc')).toEqual([
      'content-scripts/chatgpt.js',
      'content-scripts/fallback.js',
      'content-scripts/bridge.js',
    ]);
  });

  test('GitHub Copilot is only the copilot path', () => {
    expect(scriptsForUrl('https://github.com/copilot')?.[0]).toBe(
      'content-scripts/githubcopilot.js',
    );
    expect(scriptsForUrl('https://github.com/other-repo')?.[0]).toBe('content-scripts/fallback.js');
  });

  test('a normal site gets the catch-all only', () => {
    expect(scriptsForUrl('https://example.com/docs')).toEqual([
      'content-scripts/fallback.js',
      'content-scripts/bridge.js',
    ]);
  });

  test('browser pages are left alone', () => {
    expect(scriptsForUrl('chrome://extensions')).toBeNull();
    expect(scriptsForUrl('about:blank')).toBeNull();
  });
});
