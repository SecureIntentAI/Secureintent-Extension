import { browser, defineBackground } from '#imports';
import { bumpBadge, clearBadge } from '@/lib/badge';
import { desktopConnected, queryAllowed, sendBrowserUrl, sendHandled } from '@/lib/bridge/client';
import { pairingToken } from '@/lib/bridge/pairing';
import { browserAction } from '@/lib/browserAction';
import { ACCOUNT_URL, IS_FIREFOX } from '@/lib/clerkConfig';
import { consentItem, isConsentAccepted, PRIVACY_URL, TOS_URL } from '@/lib/consent';
import { getActiveEntitlement } from '@/lib/entitlement';
import { PASTE_READY } from '@/lib/paste/protocol';
import { offlineConsume } from '@/lib/quota/offline';
import { SHADOW_DEMO } from '@/lib/shadow/demoConfig';
import { reportBusinessConnection } from '@/services/businessConnection';
import { invalidateConfigSync, syncConfig } from '@/services/configService';
import { watchCookieSession } from '@/services/cookieToken';
import {
  consumeUsage,
  getUsageStatus,
  invalidateEntitlementRefresh,
  refreshEntitlementBg,
} from '@/services/entitlementBackground';
import { injectOpenTabs } from '@/services/injectOpenTabs';
import { markInstallPending, reportInstall, syncUninstallUrl } from '@/services/installAttribution';
import { installPasteWorkerBackground } from '@/services/pasteWorkerBackground';
import { ensurePolicyStream, stopPolicyStream } from '@/services/policyStream';
import {
  createSyncRunner,
  ensureSyncAlarms,
  handleRefreshMessage,
  SHADOW_POLICY_SYNC_ALARM,
  SYNC_ALARM,
} from '@/services/scheduler';
import { flushShadow, installShadowBackground, recordShadow } from '@/services/shadowBackground';
import { installShadowDemo, recordDemoShadow } from '@/services/shadowDemoBackground';
import {
  flushAuthenticatedTelemetry,
  invalidateTelemetryDelivery,
  sendAuthenticatedTelemetry,
  TELEMETRY_RETRY_ALARM,
} from '@/services/telemetryBackground';
import { installVaultBackground } from '@/services/vaultBackground';
import { forgetManualPairing } from '@/settings';

const WELCOME_URL = '/welcome.html';

/** Toolbar "!" badge nag while the user hasn't accepted the Terms & Privacy. */
async function updateConsentBadge() {
  if (await isConsentAccepted()) {
    browserAction.setBadgeText({ text: '' });
    return;
  }
  browserAction.setBadgeText({ text: '!' });
  browserAction.setBadgeBackgroundColor({ color: '#ff6b6b' });
}

export default defineBackground(() => {
  installPasteWorkerBackground();
  installVaultBackground();
  if (SHADOW_DEMO) installShadowDemo();
  else installShadowBackground();
  // First install → open the welcome/consent page. Any startup → refresh the
  // consent badge (nag until Terms & Privacy are accepted).
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      browser.tabs.create({ url: browser.runtime.getURL(WELCOME_URL) }).catch(() => {});
      // Arm the install report (every install, creator or not — see the module
      // note). On Firefox it waits for the Terms accept below.
      markInstallPending().then(() => reportInstall());
    }
    // A page that was already open does not receive manifest content scripts.
    // Install and reload both need the guard attached to those tabs.
    if (details.reason === 'install' || details.reason === 'update') {
      void injectOpenTabs();
      // Pairing is automatic now; a token pasted into an older version is not
      // left sitting in local storage.
      void forgetManualPairing().catch(() => {});
    }
    // Look for the desktop app now rather than on the first paste.
    void pairingToken({ fresh: true }).catch(() => {});
    updateConsentBadge();
    // Nothing of ours runs at uninstall time, so the address the browser opens
    // then has to be registered now — and again at every startup, since a new
    // version changes what it reports.
    syncUninstallUrl();
  });
  updateConsentBadge();
  syncUninstallUrl();

  const reconcile = createSyncRunner(async (full) => {
    await refreshEntitlementBg();
    const entitlement = await getActiveEntitlement();
    if (full || entitlement.org) await syncConfig();
    if (entitlement.org) {
      await reportBusinessConnection();
      await ensurePolicyStream();
    } else stopPolicyStream();
    await flushAuthenticatedTelemetry();
  });

  // Accepting the Terms releases the install report on Firefox (Chrome sends it
  // straight away; there it's already gone by now and this is a no-op).
  consentItem.watch(() => {
    invalidateTelemetryDelivery();
    void flushAuthenticatedTelemetry().catch(() => {});
    stopPolicyStream();
    void ensurePolicyStream();
    updateConsentBadge();
    reportInstall();
    // Firefox arms (or disarms) the goodbye ping with the same decision.
    syncUninstallUrl();
  });
  // Browser restart: retry a report that never made it out (offline at install).
  reportInstall();
  // A new browser session starts with no cached pairing: ask the desktop app.
  // Not on every worker wake — that would start the native host each time.
  browser.runtime.onStartup.addListener(() => {
    void pairingToken({ fresh: true }).catch(() => {});
  });

  // Auto-sync entitlement on sign-in / sign-out. Clerk mirrors the web-app
  // session into extension storage; when those keys change we refresh the cached
  // entitlement (and re-check binding). Content scripts watch the entitlement
  // item, so their gating updates live — no popup open or manual refresh needed.
  let entRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const sessionChanged = () => {
    invalidateEntitlementRefresh(); // invalidate immediately, before the debounce
    invalidateConfigSync();
    invalidateTelemetryDelivery();
    stopPolicyStream();
    clearTimeout(entRefreshTimer);
    entRefreshTimer = setTimeout(() => {
      void reconcile(true);
    }, 500); // debounce Clerk's burst of session writes
  };
  browser.storage.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((k) => k.toLowerCase().includes('clerk'))) sessionChanged();
  });
  if (IS_FIREFOX) watchCookieSession(sessionChanged);

  // Vault reads/writes are served by the origin-bound background handler.
  // Sync plan on startup, then drop any cached entitlement that isn't for the
  // currently signed-in user (a signed blob is otherwise portable between installs).
  void reconcile(true);
  void ensureSyncAlarms().catch(() => {});
  void flushAuthenticatedTelemetry().catch(() => {});
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === TELEMETRY_RETRY_ALARM) {
      void flushAuthenticatedTelemetry().catch(() => {});
      return;
    }
    if (a.name === SHADOW_POLICY_SYNC_ALARM.name) {
      // Revalidate membership before each team cycle; also discovers newly invited users.
      void reconcile(false);
      return;
    }
    if (a.name === SYNC_ALARM.name) {
      void reconcile(true);
      reportInstall(); // retry an install report that couldn't send (offline at install)
      void flushShadow();
      // Notice a desktop app installed (or removed) since the last look.
      void pairingToken({ fresh: true }).catch(() => {});
    }
  });
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = (msg as { type?: string })?.type;
    if (type === 'si-policy-receipt') return false;
    if (type === 'si-vault-put' || type === 'si-vault-read' || type === 'si-shadow-demo')
      return false;
    if (type === 'si-telemetry' && sender.tab && !sender.tab.incognito) {
      void sendAuthenticatedTelemetry(msg, sender.url)
        .then(sendResponse)
        .catch(() => sendResponse(null));
      return true;
    }
    if (type === 'si-open-settings') {
      void browser.tabs.create({ url: browser.runtime.getURL('/popup.html') }).catch(() => {});
      return false;
    }
    if (type === PASTE_READY) return false; // the private worker setup listener owns this response
    if (
      type === 'si-shadow-visit' ||
      type === 'si-shadow-paste-volume' ||
      type === 'si-shadow-dlp'
    ) {
      const source = {
        url: sender.url,
        frameId: sender.frameId,
        incognito: sender.tab?.incognito,
      };
      if (SHADOW_DEMO) void recordDemoShadow(msg, source).catch(() => {});
      else
        void recordShadow(msg, source)
          .then(() => flushShadow())
          .catch(() => {});
      return false;
    }
    // Per-tab badge: a content script reports how many secrets it just caught.
    if (type === 'si-detected' && sender.tab?.id != null) {
      bumpBadge(sender.tab.id, (msg as { count?: number }).count ?? 1);
      return false; // no async response needed
    }
    // Every upgrade CTA lands in the same place: the account page, where the
    // signed-in user can actually buy or manage a plan. (The popup's own Upgrade
    // button opens ACCOUNT_URL directly — same destination, no message needed.)
    if (type === 'si-open-upgrade') {
      browser.tabs.create({ url: ACCOUNT_URL }).catch(() => {});
      return false;
    }
    if (type === 'si-open-page') {
      const url = (msg as { url?: string }).url;
      if (url === TOS_URL || url === PRIVACY_URL) browser.tabs.create({ url }).catch(() => {});
      return false;
    }
    // A content script says where its focused tab is. Pass it to the desktop
    // agent so it can tell a local dev server from a real destination. Nothing
    // waits on the answer: the bridge is an optimisation, and a machine with no
    // agent on it is the normal case rather than a fault. With no desktop app to
    // pair with, `send` opens nothing.
    if (type === 'si-bridge-url') {
      const { host, port, scheme } = msg as {
        host?: string;
        port?: number | null;
        scheme?: string;
      };
      if (typeof host === 'string' && host) {
        sendBrowserUrl(host, port ?? null, scheme === 'https' ? 'https' : 'http').catch(
          () => false,
        );
      }
      return false;
    }
    // We showed a warning for this copy, so the desktop should stay quiet about
    // it. Fire-and-forget: the paste has already been dealt with either way.
    if (type === 'si-bridge-handled') {
      const { digest } = msg as { digest?: string };
      if (typeof digest === 'string' && digest) {
        sendHandled(digest).catch(() => false);
      }
      return false;
    }
    // A content script is about to warn about a paste and asks whether the
    // person already restored that text with Undo in the desktop app.
    if (type === 'si-bridge-allowed') {
      const { digest } = msg as { digest?: string };
      queryAllowed(typeof digest === 'string' ? digest : '')
        .then(sendResponse)
        .catch(() => sendResponse(false));
      return true;
    }
    // The popup asks whether a desktop app is connected right now.
    if (type === 'si-bridge-check') {
      desktopConnected()
        .then(sendResponse)
        .catch(() => sendResponse(false));
      return true;
    }
    // User accepted Terms & Privacy (welcome page or popup) → clear the nag badge.
    if (type === 'si-consent-accepted') {
      updateConsentBadge();
      return false;
    }
    // Anonymise & Paste quota (signed-in users): status + consume via the Worker.
    if (type === 'si-quota-status') {
      getUsageStatus().then(sendResponse);
      return true;
    }
    if (type === 'si-quota-consume') {
      consumeUsage()
        .then((result) => result ?? offlineConsume())
        .then(sendResponse)
        .catch(() => sendResponse({ allowed: false }));
      return true;
    }
    // Popup asked to refresh the entitlement (e.g. after sign-in / returning from checkout).
    if (type === 'si-refresh-entitlement') {
      refreshEntitlementBg().then(sendResponse);
      return true;
    }
    handleRefreshMessage(msg).then(sendResponse);
    return true; // keep the message channel open for the async response
  });
  // Reset a tab's badge count when it navigates to a new page.
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') clearBadge(tabId);
  });
});
