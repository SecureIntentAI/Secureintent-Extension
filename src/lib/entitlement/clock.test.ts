import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  CLOCK_FLOOR_WRITE_MS,
  clockFloorItem,
  resetClockFloorMemory,
  setClockFloorFromServer,
  trustedNowMs,
  trustedNowMsSync,
} from './clock';

const T = 1_800_000_000_000;

beforeEach(() => {
  fakeBrowser.reset();
  resetClockFloorMemory();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('clock floor', () => {
  test('follows the clock forward and stores it', async () => {
    expect(await trustedNowMs()).toBe(T);
    expect(await clockFloorItem.getValue()).toBe(T);
  });

  test('never goes back when the clock does', async () => {
    await trustedNowMs();
    vi.setSystemTime(T - 86_400_000);
    expect(await trustedNowMs()).toBe(T);
    expect(trustedNowMsSync()).toBe(T);
    expect(await clockFloorItem.getValue()).toBe(T);
  });

  test('writes at most every few minutes', async () => {
    await trustedNowMs();
    vi.setSystemTime(T + 60_000);
    expect(await trustedNowMs()).toBe(T + 60_000);
    expect(await clockFloorItem.getValue()).toBe(T); // not written yet
    vi.setSystemTime(T + CLOCK_FLOOR_WRITE_MS);
    await trustedNowMs();
    expect(await clockFloorItem.getValue()).toBe(T + CLOCK_FLOOR_WRITE_MS);
  });

  test('a verified issuedAt (seconds) raises it at once', async () => {
    const issuedAtSec = T / 1000 + 3600;
    expect(await setClockFloorFromServer(issuedAtSec)).toBe(issuedAtSec * 1000);
    expect(await clockFloorItem.getValue()).toBe(issuedAtSec * 1000);
  });

  test('a verified issuedAt replaces a higher floor, then max() applies again', async () => {
    await clockFloorItem.setValue(T + 365 * 86_400_000);
    expect(await setClockFloorFromServer(T / 1000 - 60)).toBe(T);
    expect(await clockFloorItem.getValue()).toBe(T - 60_000);
    vi.setSystemTime(T - 86_400_000);
    expect(await trustedNowMs()).toBe(T - 60_000);
  });

  test('a bad issuedAt changes nothing', async () => {
    await clockFloorItem.setValue(T + 1000);
    expect(await setClockFloorFromServer('soon')).toBe(T + 1000);
    expect(await setClockFloorFromServer(Number.NaN)).toBe(T + 1000);
    expect(await clockFloorItem.getValue()).toBe(T + 1000);
  });
});
