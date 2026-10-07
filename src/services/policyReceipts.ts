import { type Browser, browser } from '#imports';

/** Long enough for a busy page's content script to answer; short enough to keep the minute report prompt. */
export const PROBE_WAIT_MS = 1_500;

type Tab = Browser.tabs.Tab;

/**
 * Only tabs that can answer are expected to. A discarded (sleeping) tab has no
 * running script, and a loading one has not attached its guard yet; both pick
 * the policy up from storage when they run, so they must not hold the receipt
 * at "pending" and make the console's rollout flap between check-ins.
 */
/**
 * Browsers never run extension scripts on their own add-on stores, nor on
 * Firefox's restricted Mozilla domains (extensions.webextensions.restrictedDomains).
 */
const NO_SCRIPT_PAGES =
  /^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons|(?:addons|discovery\.addons|support|install)\.mozilla\.org|(?:accounts|api\.accounts|oauth\.accounts|profile\.accounts)\.firefox\.com|(?:accounts-static|addons|content)\.cdn\.mozilla\.net|sync\.services\.mozilla\.com)(?:\/|$)/;
/** A PDF opens in the browser's own viewer, where content scripts do not run. */
const PDF_VIEWER = /\.pdf$/i;

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};

function probeable(tab: Tab): tab is Tab & { id: number } {
  const url = tab.url ?? '';
  return (
    !tab.incognito &&
    tab.id !== undefined &&
    /^https?:/.test(url) &&
    !NO_SCRIPT_PAGES.test(url) &&
    !PDF_VIEWER.test(pathOf(url)) &&
    !tab.discarded &&
    // Chrome freezes background tabs; a frozen page cannot answer until it thaws.
    !(tab as Tab & { frozen?: boolean }).frozen &&
    tab.status === 'complete'
  );
}

/** A fresh challenge measures running page guards; never treats a storage write as enforcement. */
export async function collectPolicyReceipts(orgId: string, version: number) {
  const tabs = (await browser.tabs.query({})).filter(probeable);
  const expected = new Set(tabs.map((t) => t.id));
  const nonce = crypto.randomUUID();
  const confirmed = new Set<number>();
  let disabled = false;
  let stale = false;
  let guards = 0;
  const seen = new Set<string>();
  const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (raw, sender) => {
    const m = raw as {
      type?: string;
      nonce?: string;
      orgId?: string;
      version?: number;
      active?: boolean;
    };
    if (
      m?.type !== 'si-policy-receipt' ||
      m.nonce !== nonce ||
      sender.tab?.id === undefined ||
      !expected.has(sender.tab.id)
    )
      return false;
    const key = `${sender.tab.id}:${sender.frameId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!m.active) disabled = true;
    else if (m.orgId !== orgId || m.version !== version) stale = true;
    else {
      guards++;
      if ((sender.frameId ?? 0) === 0) confirmed.add(sender.tab.id);
    }
    return false;
  };
  browser.runtime.onMessage.addListener(listener);
  try {
    for (const tab of tabs)
      void browser.tabs.sendMessage(tab.id, { type: 'si-policy-probe', nonce }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, PROBE_WAIT_MS));
    return {
      policyState: disabled
        ? 'disabled'
        : stale
          ? 'pending'
          : !tabs.length
            ? 'downloaded'
            : confirmed.size === expected.size
              ? 'guards_confirmed'
              : 'pending',
      confirmedGuards: guards,
      expectedPages: tabs.length,
    };
  } finally {
    browser.runtime.onMessage.removeListener(listener);
  }
}
