import { ensurePolicyStream, stopPolicyStream } from '@/services/policyStream';
import { reportBusinessConnection } from '@/services/businessConnection';
import { flushAuthenticatedTelemetry, sendAuthenticatedTelemetry } from '@/services/telemetryBackground';
import { browser, defineBackground } from '#imports';
import { bumpBadge, clearBadge } from '@/lib/badge';
import { sendBrowserUrl, sendHandledHash } from '@/lib/bridge/client';
import { browserAction } from '@/lib/browserAction';
import { ACCOUNT_URL } from '@/lib/clerkConfig';
import { consentItem, isConsentAccepted, PRIVACY_URL, TOS_URL } from '@/lib/consent';
import { getActiveEntitlement } from '@/lib/entitlement';
import { PASTE_READY } from '@/lib/paste/protocol';
import { offlineConsume } from '@/lib/quota/offline';
import { invalidateConfigSync, syncConfig } from '@/services/configService';
import {
  consumeUsage,
  getUsageStatus,
  invalidateEntitlementRefresh,
  refreshEntitlementBg,
} from '@/services/entitlementBackground';
import { injectOpenTabs } from '@/services/injectOpenTabs';
import { markInstallPending, reportInstall, syncUninstallUrl } from '@/services/installAttribution';
import { installPasteWorkerBackground } from '@/services/pasteWorkerBackground';
import { handleRefreshMessage, SHADOW_POLICY_SYNC_ALARM, SYNC_ALARM } from '@/services/scheduler';
import { flushShadow, installShadowBackground, recordShadow } from '@/services/shadowBackground';
import { installVaultBackground } from '@/services/vaultBackground';
import { isBridgeEnabled } from '@/settings';
import { SHADOW_DEMO } from '@/lib/shadow/demoConfig';
import { installShadowDemo, recordDemoShadow } from '@/services/shadowDemoBackground';

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
    }
    updateConsentBadge();
    // Nothing of ours runs at uninstall time, so the address the browser opens
    // then has to be registered now — and again at every startup, since a new
    // version changes what it reports.
    syncUninstallUrl();
  });
  updateConsentBadge();
  syncUninstallUrl();

  // Accepting the Terms releases the install report on Firefox (Chrome sends it
  // straight away; there it's already gone by now and this is a no-op).
  consentItem.watch(() => {
    stopPolicyStream();
    void ensurePolicyStream();
    updateConsentBadge();
    reportInstall();
    // Firefox arms (or disarms) the goodbye ping with the same decision.
    syncUninstallUrl();
  });
  // Browser restart: retry a report that never made it out (offline at install).
  reportInstall();

  // Auto-sync entitlement on sign-in / sign-out. Clerk mirrors the web-app
  // session into extension storage; when those keys change we refresh the cached
  // entitlement (and re-check binding). Content scripts watch the entitlement
  // item, so their gating updates live — no popup open or manual refresh needed.
  let entRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  browser.storage.onChanged.addListener((changes) => {
    if (!Object.keys(changes).some((k) => k.toLowerCase().includes('clerk'))) return;
    invalidateEntitlementRefresh(); // invalidate immediately, before the debounce
    invalidateConfigSync();
    stopPolicyStream();
    clearTimeout(entRefreshTimer);
    entRefreshTimer = setTimeout(() => {
      void refreshEntitlementBg().then(() => syncConfig()).then(() => reportBusinessConnection()).then(() => ensurePolicyStream()).catch(() => {});
    }, 500); // debounce Clerk's burst of session writes
  });

  // Vault reads/writes are served by the origin-bound background handler.
  // Sync plan on startup, then drop any cached entitlement that isn't for the
  // currently signed-in user (a signed blob is otherwise portable between installs).
  void refreshEntitlementBg().then(() => syncConfig()).then(() => reportBusinessConnection()).then(() => ensurePolicyStream()).catch(() => {});
  browser.alarms.create(SYNC_ALARM.name, { periodInMinutes: SYNC_ALARM.periodInMinutes });
  browser.alarms.create(SHADOW_POLICY_SYNC_ALARM.name, {
    periodInMinutes: SHADOW_POLICY_SYNC_ALARM.periodInMinutes,
  });
  browser.alarms.create('si-telemetry-retry', { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === 'si-telemetry-retry') {
      void flushAuthenticatedTelemetry().catch(() => {});
      return;
    }
    if (a.name === SHADOW_POLICY_SYNC_ALARM.name) {
      // Revalidate membership before each team cycle; also discovers newly invited users.
      void refreshEntitlementBg().then(() => getActiveEntitlement()).then(async entitlement => {
        if (entitlement.org) { await syncConfig(); await reportBusinessConnection(); await ensurePolicyStream(); }
        else stopPolicyStream();
      }).catch(() => {});
      return;
    }
    if (a.name === SYNC_ALARM.name) {
      syncConfig();
      void refreshEntitlementBg(); // ride the existing 2h alarm
      reportInstall(); // retry an install report that couldn't send (offline at install)
      void flushShadow();
    }
  });
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = (msg as { type?: string })?.type;
    if (type === 'si-policy-receipt') return false;
    if (type === 'si-vault-put' || type === 'si-vault-read' || type === 'si-shadow-demo') return false;
    if (type === 'si-telemetry' && sender.tab && !sender.tab.incognito) {
      void sendAuthenticatedTelemetry(msg, sender.url).then(sendResponse).catch(() => sendResponse(null));
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
      else void recordShadow(msg, source).then(() => flushShadow()).catch(() => {});
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
    // agent on it is the normal case rather than a fault.
    if (type === 'si-bridge-url') {
      const { host, port, scheme } = msg as {
        host?: string;
        port?: number | null;
        scheme?: string;
      };
      if (typeof host === 'string' && host) {
        isBridgeEnabled()
          .then((on) =>
            on ? sendBrowserUrl(host, port ?? null, scheme === 'https' ? 'https' : 'http') : false,
          )
          .catch(() => false);
      }
      return false;
    }
    // We showed a warning for this copy, so the desktop should stay quiet about
    // it. Fire-and-forget: the paste has already been dealt with either way.
    if (type === 'si-bridge-handled') {
      const { hash } = msg as { hash?: string };
      if (typeof hash === 'string' && hash) {
        isBridgeEnabled()
          .then((on) => (on ? sendHandledHash(hash) : false))
          .catch(() => false);
      }
      return false;
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
