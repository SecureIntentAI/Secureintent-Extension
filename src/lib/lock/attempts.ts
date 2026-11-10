/**
 * Session Lock unlock attempts. The count lives in extension storage, owned by
 * the background, so it carries across page reloads, tabs and browser restarts.
 * The first few misses are free; after that each miss doubles the wait.
 */
export const LOCK_UNLOCK_MESSAGE = 'si-lock-unlock';

export interface UnlockResult {
  ok: boolean;
  /** Epoch ms before which another PIN will not be checked. */
  retryAfter: number;
}

export const FREE_ATTEMPTS = 5;
export const BASE_LOCKOUT_MS = 30_000;
export const MAX_LOCKOUT_MS = 15 * 60_000;

export interface AttemptState {
  failures: number;
  /** Epoch ms before which no PIN is checked. 0 when there is no wait. */
  retryAfter: number;
}

export const NO_ATTEMPTS: AttemptState = { failures: 0, retryAfter: 0 };

/** The wait that follows the given number of consecutive misses. */
export function lockoutMs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * 2 ** (failures - FREE_ATTEMPTS));
}

export function recordFailure(state: AttemptState, now: number): AttemptState {
  const failures = state.failures + 1;
  const wait = lockoutMs(failures);
  return { failures, retryAfter: wait ? now + wait : 0 };
}

/** Anything unreadable counts as a full lockout rather than a fresh start. */
export function parseAttemptState(value: unknown, now: number): AttemptState {
  if (value === undefined || value === null) return NO_ATTEMPTS;
  const v = value as Partial<AttemptState>;
  if (
    typeof v === 'object' &&
    Number.isSafeInteger(v.failures) &&
    (v.failures as number) >= 0 &&
    typeof v.retryAfter === 'number' &&
    Number.isFinite(v.retryAfter) &&
    v.retryAfter >= 0
  ) {
    // A wait can never be longer than the longest lockout.
    return {
      failures: v.failures as number,
      retryAfter: Math.min(v.retryAfter, now + MAX_LOCKOUT_MS),
    };
  }
  return { failures: FREE_ATTEMPTS, retryAfter: now + MAX_LOCKOUT_MS };
}
