import { browser } from '#imports';
import { LOCK_UNLOCK_MESSAGE, type UnlockResult } from './attempts';

/** Ask the background to check a Session Lock PIN. Any failure is a refusal. */
export async function requestUnlock(pin: string): Promise<UnlockResult> {
  try {
    const result = (await browser.runtime.sendMessage({ type: LOCK_UNLOCK_MESSAGE, pin })) as
      | Partial<UnlockResult>
      | undefined;
    return {
      ok: result?.ok === true,
      retryAfter: typeof result?.retryAfter === 'number' ? result.retryAfter : 0,
    };
  } catch {
    return { ok: false, retryAfter: 0 };
  }
}
