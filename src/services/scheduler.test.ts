import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import * as configService from '@/services/configService';
import {
  createSyncRunner,
  ensureSyncAlarms,
  handleRefreshMessage,
  SHADOW_POLICY_SYNC_ALARM,
  SYNC_ALARM,
} from './scheduler';

beforeEach(() => fakeBrowser.reset());
afterEach(() => vi.restoreAllMocks());

describe('config scheduler', () => {
  test('worker restart preserves alarms rather than postponing them', async () => {
    vi.spyOn(fakeBrowser.alarms, 'get').mockImplementation(async (name) => ({
      name: name!,
      scheduledTime: 123,
      periodInMinutes: name === SYNC_ALARM.name ? 120 : 1,
    }));
    const create = vi.spyOn(fakeBrowser.alarms, 'create');
    await ensureSyncAlarms();
    expect(create).not.toHaveBeenCalled();
  });

  test('new alarms spread initial requests and retain the policy cadence', async () => {
    vi.spyOn(fakeBrowser.alarms, 'get').mockResolvedValue(undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const create = vi.spyOn(fakeBrowser.alarms, 'create');
    await ensureSyncAlarms();
    expect(create).toHaveBeenCalledWith(SHADOW_POLICY_SYNC_ALARM.name, {
      periodInMinutes: 1,
      delayInMinutes: 0.75,
    });
    expect(create).toHaveBeenCalledWith(SYNC_ALARM.name, {
      periodInMinutes: 120,
      delayInMinutes: 90,
    });
  });

  test('serializes cycles and retains a full refresh requested during a failed cycle', async () => {
    let reject!: (error: Error) => void;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, no) => {
            reject = no;
          }),
      )
      .mockResolvedValue(undefined);
    const reconcile = createSyncRunner(run);
    const pending = reconcile(false);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    const joined = reconcile(true);
    reconcile(false);
    expect(joined).toBe(pending);
    expect(run).toHaveBeenCalledTimes(1);
    reject(new Error('offline'));
    await pending;
    expect(run.mock.calls).toEqual([[false], [true]]);
    await reconcile(false);
    expect(run.mock.calls).toEqual([[false], [true], [false]]);
  });

  test('refresh message triggers syncConfig and returns the result', async () => {
    const spy = vi
      .spyOn(configService, 'syncConfig')
      .mockResolvedValue({ status: 'updated', version: 9 });
    const reply = await handleRefreshMessage({ type: 'si-refresh-config' });
    expect(spy).toHaveBeenCalledOnce();
    expect(reply).toEqual({ status: 'updated', version: 9 });
  });

  test('ignores unrelated messages', async () => {
    const spy = vi.spyOn(configService, 'syncConfig').mockResolvedValue({ status: 'updated' });
    const reply = await handleRefreshMessage({ type: 'other' });
    expect(spy).not.toHaveBeenCalled();
    expect(reply).toBeNull();
  });

  test('SYNC_ALARM period is 120 minutes', () => {
    expect(SYNC_ALARM.periodInMinutes).toBe(120);
  });
});
