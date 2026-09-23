import { browser, storage } from '#imports';

/**
 * Terms & Privacy consent. Blocking: until the user accepts the current version,
 * the paste guard shows a consent gate on the first warning and the popup shows
 * a consent screen. Stored in `sync` so it follows the user's Chrome profile
 * across devices. Bump TERMS_VERSION to re-prompt everyone after a terms change.
 */
export const TERMS_VERSION = 2;

export const TOS_URL = 'https://secureintent.ai/tos';
export const PRIVACY_URL = 'https://secureintent.ai/privacy';

export interface ConsentRecord {
  version: number;
  acceptedAt: number; // epoch ms
}

export const consentItem = storage.defineItem<ConsentRecord | null>('sync:si_terms_consent', {
  fallback: null,
});

/** Pure check: is this stored consent record valid for the current terms version? */
export function consentSatisfied(record: ConsentRecord | null, version = TERMS_VERSION): boolean {
  return record != null && record.version >= version;
}

/** Has the user accepted the current Terms & Privacy version? */
export async function isConsentAccepted(): Promise<boolean> {
  return consentSatisfied(await consentItem.getValue());
}

/** Record acceptance of the current terms version. */
export async function acceptTerms(nowMs = Date.now()): Promise<void> {
  await consentItem.setValue({ version: TERMS_VERSION, acceptedAt: nowMs });
}

/**
 * Open Terms or Privacy in a normal browser tab.
 *
 * An extension page must not follow these links itself. A `target="_blank"`
 * anchor inside the consent label makes Chrome replace the welcome tab with
 * about:blank.
 */
export function openPolicyPage(
  url: string,
): (event: { preventDefault(): void; stopPropagation(): void }) => void {
  return (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (url !== TOS_URL && url !== PRIVACY_URL) return;
    try {
      const opened = browser.tabs?.create({ url });
      if (opened && typeof opened.catch === 'function') {
        void opened.catch(() => {
          browser.runtime.sendMessage({ type: 'si-open-page', url }).catch(() => {});
        });
        return;
      }
    } catch {
      // Content scripts have no tabs API. The background opens the page.
    }
    browser.runtime.sendMessage({ type: 'si-open-page', url }).catch(() => {});
  };
}
