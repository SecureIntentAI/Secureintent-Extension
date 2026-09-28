import { beforeEach, describe, expect, test } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  acceptTerms,
  consentItem,
  consentSatisfied,
  isConsentAccepted,
  TERMS_VERSION,
} from './index';

beforeEach(() => fakeBrowser.reset());

describe('consentSatisfied', () => {
  test('null → false', () => {
    expect(consentSatisfied(null)).toBe(false);
  });
  test('current version → true', () => {
    expect(consentSatisfied({ version: TERMS_VERSION, acceptedAt: 1 })).toBe(true);
  });
  test('newer stored version → true', () => {
    expect(consentSatisfied({ version: TERMS_VERSION + 5, acceptedAt: 1 })).toBe(true);
  });
  test('previous terms version → false (re-prompt after terms change)', () => {
    expect(consentSatisfied({ version: TERMS_VERSION - 1, acceptedAt: 1 })).toBe(false);
  });
});

describe('accept + isConsentAccepted', () => {
  test('unaccepted by default', async () => {
    expect(await isConsentAccepted()).toBe(false);
  });
  test('accept records the current version and flips the flag', async () => {
    await acceptTerms(1234);
    expect(await consentItem.getValue()).toEqual({ version: TERMS_VERSION, acceptedAt: 1234 });
    expect(await isConsentAccepted()).toBe(true);
  });
});
