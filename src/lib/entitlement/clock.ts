import { storage } from '#imports';

/**
 * The highest time this install has seen, in ms. Plan and trial expiry are
 * checked against max(Date.now(), this), so an expiry reached stays reached.
 * Nothing unsigned ever lowers
 * it: the local clock only raises it. The one exception is a verified refresh,
 * which sets it to the Worker's signed issuedAt even if that is lower, because
 * the server's signed time is the truth. That unlocks a plan for someone whose
 * clock was once set ahead (24 Nov 2026).
 */
export const clockFloorItem = storage.defineItem<number>('local:si_clock_floor', { fallback: 0 });

/** Writes are throttled: losing a few minutes of floor is harmless (24 Nov 2026). */
export const CLOCK_FLOOR_WRITE_MS = 5 * 60_000;

/** This context's view of the floor, so the synchronous hot paths can use it. */
let memFloorMs = 0;

/** max(Date.now(), the floor this context has seen). Synchronous, no storage read. */
export function trustedNowMsSync(): number {
  return Math.max(Date.now(), memFloorMs);
}

/**
 * The time to check expiry against: the max of the stored floor, the local
 * clock and `atLeastMs` (a verified issuedAt). Stores a higher value when it is
 * more than CLOCK_FLOOR_WRITE_MS above the stored one, or when `force` is set.
 * Never lowers the stored value. A storage failure falls back to the clock.
 */
export async function trustedNowMs(atLeastMs = 0, force = false): Promise<number> {
  let stored = 0;
  let readOk = false;
  try {
    const value = await clockFloorItem.getValue();
    if (typeof value === 'number' && Number.isFinite(value)) stored = value;
    readOk = true;
  } catch {}
  const safeAtLeast = Number.isFinite(atLeastMs) ? atLeastMs : 0;
  // Storage is the source of truth, so a server reset made in the background
  // also reaches other contexts. This context's memory only stands in when
  // storage can't be read (24 Nov 2026).
  const now = Math.max(Date.now(), stored, readOk ? 0 : memFloorMs, safeAtLeast);
  memFloorMs = now;
  if (now > stored && (force || now - stored >= CLOCK_FLOOR_WRITE_MS)) {
    await clockFloorItem.setValue(now).catch(() => {});
  }
  return now;
}

/**
 * Set the floor to a VERIFIED entitlement's signed issuedAt (Unix seconds),
 * replacing it even when that lowers it: the server's signed time is the
 * truth, and this is how a clock that was once set ahead stops locking the
 * plan. Only call it with a blob whose signature has been checked. After this
 * the usual max(floor, Date.now()) rule applies again (24 Nov 2026).
 */
export async function setClockFloorFromServer(issuedAtSec: unknown): Promise<number> {
  if (typeof issuedAtSec !== 'number' || !Number.isFinite(issuedAtSec) || issuedAtSec <= 0)
    return trustedNowMs();
  const ms = issuedAtSec * 1000;
  memFloorMs = ms;
  await clockFloorItem.setValue(ms).catch(() => {});
  return Math.max(Date.now(), ms);
}

/** Tests only: forget this context's in-memory floor. */
export function resetClockFloorMemory(): void {
  memFloorMs = 0;
}
