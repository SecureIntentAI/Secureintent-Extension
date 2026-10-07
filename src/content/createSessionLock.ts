import { browser, type ContentScriptContext, storage } from '#imports';
import { configItem } from '@/lib/config';
import { siDebug } from '@/lib/debug';
import { entitlementItem, hasFeature } from '@/lib/entitlement';
import { getOrCreateSalt, type KeyValueStore } from '@/lib/fingerprint';
import { verifyPin } from '@/lib/lock';
import { type LockWarningHandle, mountLockWarning } from '@/overlay/mountLockWarning';
import { mountSessionLock, type SessionLockHandle } from '@/overlay/mountSessionLock';
import {
  getSessionLockConfig,
  isSessionLockEnforced,
  sessionLockEnabledItem,
  sessionLockPinHashItem,
  sessionLockTimeoutItem,
} from '@/settings';

const browserStore: KeyValueStore = {
  get: async (key) => (await storage.getItem<string>(`local:${key}`)) ?? undefined,
  set: (key, value) => storage.setItem(`local:${key}`, value),
};
const LOCKED_FLAG = 'si_session_locked';
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'] as const;

/** Reactive walk-away deterrent; the underlying console session remains live. */
export async function createSessionLock(ctx: ContentScriptContext): Promise<void> {
  let revision = 0;
  let refreshRevision = 0;
  let configured = false;
  let disposed = false;
  let enabled = false;
  let pinHash: string | null = null;
  let timeoutMs = 300_000;
  let locked = false;
  let setupRequired = false;
  let handle: SessionLockHandle | undefined;
  let warning: LockWarningHandle | undefined;
  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  let lockTimer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = Date.now();
  let attempts = 0;
  let retryAfter = 0;
  const salt = await getOrCreateSalt(browserStore);
  const clearTimers = () => {
    clearTimeout(warnTimer);
    clearTimeout(lockTimer);
    warning?.remove();
    warning = undefined;
  };
  const setFlag = (value: boolean) => {
    try {
      if (value) sessionStorage.setItem(LOCKED_FLAG, '1');
      else sessionStorage.removeItem(LOCKED_FLAG);
    } catch {}
  };
  const arm = () => {
    clearTimers();
    if (!enabled || locked || disposed) return;
    const remaining = Math.max(0, timeoutMs - (Date.now() - lastActivity));
    if (remaining === 0) {
      void lock();
      return;
    }
    const warnMs = Math.min(10_000, Math.floor(timeoutMs / 2), remaining);
    warnTimer = setTimeout(async () => {
      const version = revision;
      lockTimer = setTimeout(() => {
        void lock();
      }, warnMs);
      const ui = await mountLockWarning(ctx, { seconds: Math.round(warnMs / 1000) });
      if (disposed || locked || version !== revision) ui.remove();
      else warning = ui;
    }, remaining - warnMs);
  };
  const lock = async () => {
    if (!enabled || locked || disposed) return;
    locked = true;
    setFlag(true);
    clearTimers();
    const version = revision;
    const ui = await mountSessionLock(ctx, {
      setupRequired,
      onSetup: () => {
        void browser.runtime.sendMessage({ type: 'si-open-settings' }).catch(() => {});
      },
      onUnlock: async (pin) => {
        if (disposed || version !== revision || !pinHash || Date.now() < retryAfter) return false;
        const valid = await verifyPin(pin, salt, pinHash);
        if (disposed || version !== revision) return false;
        if (!valid) {
          if (++attempts >= 5) {
            retryAfter = Date.now() + 30_000;
            attempts = 0;
          }
          return false;
        }
        attempts = 0;
        locked = false;
        setFlag(false);
        handle?.remove();
        handle = undefined;
        lastActivity = Date.now();
        arm();
        return true;
      },
    });
    if (disposed || version !== revision || !locked) ui.remove();
    else handle = ui;
  };
  const refresh = async () => {
    const version = ++refreshRevision;
    const [config, enforced, entitled] = await Promise.all([
      getSessionLockConfig(),
      isSessionLockEnforced(),
      hasFeature('session_lock'),
    ]);
    if (disposed || version !== refreshRevision) return;
    const nextSetupRequired = enforced && !config.pinHash;
    const nextEnabled = enforced || (entitled && config.enabled && !!config.pinHash);
    const nextTimeout = Number.isFinite(config.timeoutMs)
      ? Math.max(1000, config.timeoutMs)
      : 300_000;
    // Renewing the signed entitlement is not user activity. Keep both the idle
    // deadline and an existing lock's unlock callback when access is unchanged.
    if (
      configured &&
      enabled === nextEnabled &&
      setupRequired === nextSetupRequired &&
      pinHash === config.pinHash &&
      timeoutMs === nextTimeout
    )
      return;
    configured = true;
    revision++;
    siDebug('session-lock', 'configuration applied', {
      enforced,
      entitled,
      enabled: config.enabled,
      hasPin: !!config.pinHash,
    });
    const wasLocked = locked;
    const wasEnabled = enabled;
    clearTimers();
    handle?.remove();
    handle = undefined;
    locked = false;
    setupRequired = nextSetupRequired;
    enabled = nextEnabled;
    pinHash = config.pinHash;
    timeoutMs = nextTimeout;
    if (enabled && !wasEnabled) lastActivity = Date.now();
    let saved = false;
    try {
      saved = sessionStorage.getItem(LOCKED_FLAG) === '1';
    } catch {}
    if (!enabled) {
      setFlag(false);
      return;
    }
    if (setupRequired || wasLocked || saved || document.visibilityState === 'hidden') await lock();
    else arm();
  };
  const changed = () => {
    void refresh().catch(() => {});
  };
  const stops = [
    configItem.watch(changed),
    entitlementItem.watch(changed),
    sessionLockEnabledItem.watch(changed),
    sessionLockPinHashItem.watch(changed),
    sessionLockTimeoutItem.watch(changed),
  ];
  const activity = () => {
    if (locked || Date.now() - lastActivity < 1000) return;
    lastActivity = Date.now();
    arm();
  };
  for (const event of ACTIVITY_EVENTS)
    ctx.addEventListener(document, event, activity, { passive: true, capture: true });
  ctx.addEventListener(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') void lock();
  });
  ctx.onInvalidated?.(() => {
    disposed = true;
    revision++;
    clearTimers();
    handle?.remove();
    for (const stop of stops) stop();
  });
  await refresh();
}
