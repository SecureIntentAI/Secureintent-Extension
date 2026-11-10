import { expect, test } from 'vitest';
import {
  BASE_LOCKOUT_MS,
  FREE_ATTEMPTS,
  lockoutMs,
  MAX_LOCKOUT_MS,
  NO_ATTEMPTS,
  parseAttemptState,
  recordFailure,
} from './attempts';

test('the first misses are free, then each miss doubles the wait up to a cap', () => {
  for (let n = 0; n < FREE_ATTEMPTS; n++) expect(lockoutMs(n)).toBe(0);
  expect(lockoutMs(FREE_ATTEMPTS)).toBe(BASE_LOCKOUT_MS);
  expect(lockoutMs(FREE_ATTEMPTS + 1)).toBe(BASE_LOCKOUT_MS * 2);
  expect(lockoutMs(FREE_ATTEMPTS + 2)).toBe(BASE_LOCKOUT_MS * 4);
  expect(lockoutMs(FREE_ATTEMPTS + 50)).toBe(MAX_LOCKOUT_MS);
});

test('recordFailure counts misses and sets the wait from now', () => {
  let state = NO_ATTEMPTS;
  for (let n = 1; n < FREE_ATTEMPTS; n++) {
    state = recordFailure(state, 1000);
    expect(state).toEqual({ failures: n, retryAfter: 0 });
  }
  state = recordFailure(state, 1000);
  expect(state).toEqual({ failures: FREE_ATTEMPTS, retryAfter: 1000 + BASE_LOCKOUT_MS });
});

test('stored state is read back, capped, or treated as a full wait when unreadable', () => {
  expect(parseAttemptState(undefined, 0)).toEqual(NO_ATTEMPTS);
  expect(parseAttemptState({ failures: 2, retryAfter: 0 }, 0)).toEqual({
    failures: 2,
    retryAfter: 0,
  });
  expect(parseAttemptState({ failures: 6, retryAfter: 1e15 }, 10)).toEqual({
    failures: 6,
    retryAfter: 10 + MAX_LOCKOUT_MS,
  });
  expect(parseAttemptState('junk', 10)).toEqual({
    failures: FREE_ATTEMPTS,
    retryAfter: 10 + MAX_LOCKOUT_MS,
  });
});
