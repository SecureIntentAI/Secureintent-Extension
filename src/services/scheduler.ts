import { browser } from '#imports';
import { type SyncResult, syncConfig } from './configService';

export const SYNC_ALARM = { name: 'si-config-sync', periodInMinutes: 120 };
// Shadow policy writes are applied through the same signed config bundle. Keep
// personal refresh cadence at two hours; team membership and policy refresh every minute.
export const SHADOW_POLICY_SYNC_ALARM = { name: 'si-shadow-policy-sync', periodInMinutes: 1 };

export async function handleRefreshMessage(msg: unknown): Promise<SyncResult | null> {
  if (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: string }).type === 'si-refresh-config'
  ) {
    return syncConfig();
  }
  return null;
}

/** Preserve scheduled alarms across MV3 worker restarts; spread initial wakeups. */
export async function ensureSyncAlarms(): Promise<void> {
  await Promise.all(
    [SYNC_ALARM, SHADOW_POLICY_SYNC_ALARM].map(async (alarm) => {
      const existing = await browser.alarms.get(alarm.name);
      if (existing?.periodInMinutes === alarm.periodInMinutes) return;
      await browser.alarms.create(alarm.name, {
        periodInMinutes: alarm.periodInMinutes,
        delayInMinutes: alarm.periodInMinutes * (0.5 + Math.random()),
      });
    }),
  );
}

/** Share a running cycle and remember requests arriving while it is pending. */
export interface SyncRunOptions {
  /** Replace the stored config even at the same version (once, after an update). */
  force?: boolean;
}

export function createSyncRunner(run: (full: boolean, options: SyncRunOptions) => Promise<void>) {
  let running: Promise<void> | undefined;
  let pending = false;
  let fullPending = false;
  let forcePending = false;
  return (full: boolean, options: SyncRunOptions = {}): Promise<void> => {
    pending = true;
    fullPending ||= full;
    forcePending ||= Boolean(options.force);
    if (running) return running;
    running = (async () => {
      await Promise.resolve(); // assign running before even a synchronous failure
      try {
        while (pending) {
          const fullCycle = fullPending;
          const cycleOptions = { force: forcePending };
          pending = false;
          fullPending = false;
          forcePending = false;
          // A failed cycle must not discard a newer account's pending refresh.
          try {
            await run(fullCycle, cycleOptions);
          } catch {
            /* next alarm retries */
          }
        }
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
}
