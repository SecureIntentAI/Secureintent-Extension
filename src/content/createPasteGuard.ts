import { browser, type ContentScriptContext, storage } from '#imports';
import { contentHash } from '@/lib/bridge/hash';
import { DEFAULT_BUNDLE, getActiveBundle } from '@/lib/config';
import { acceptTerms, consentItem, consentSatisfied, isConsentAccepted } from '@/lib/consent';
import { elapsedMs, siDebug, siError } from '@/lib/debug';
import { detectSecrets, sanitize, summarize, TOKEN_RE, tokenizeSecrets } from '@/lib/detection';
import { getEntitlementSnapshot, hasFeatureCached, initEntitlementCache } from '@/lib/entitlement';
import { notifyAction, notifyDetections } from '@/lib/features';
import {
  computeFingerprint,
  type Fingerprint,
  getOrCreateSalt,
  type KeyValueStore,
} from '@/lib/fingerprint';
import { consumeAnonymize, formatQuotaReset, getAnonymizeStatus } from '@/lib/quota';
import type { TelemetryAction } from '@/lib/telemetry/types';
import { type VaultStore, vaultPut, vaultSnapshot } from '@/lib/vault';
import { mountOverlay } from '@/overlay/mount';
import { mountConsentGate } from '@/overlay/mountConsentGate';
import { buildEvent, sendTelemetry } from '@/services/telemetryService';
import { enabledItem, isEnabled, recordBlocked } from '@/settings';
import { findComposer } from './findComposer';
import { createGuardRuntime } from './guardRuntime';
import { capturePasteSelection } from './pasteSelection';
import type { SiteConfig } from './types';

const ACTION_BY_OVERLAY: Record<'paste' | 'redact' | 'cancel', TelemetryAction> = {
  paste: 'paste_anyway',
  redact: 'paste_anonymously',
  cancel: 'cancelled',
};
const browserStore: KeyValueStore = {
  get: async (key) => (await storage.getItem<string>(`local:${key}`)) ?? undefined,
  set: (key, value) => storage.setItem(`local:${key}`, value),
};
// RAM-only (cleared on browser close) — holds token→secret maps for rehydration.
const sessionStore: VaultStore = {
  get: async (key) => (await storage.getItem<string>(`session:${key}`)) ?? undefined,
  set: (key, value) => storage.setItem(`session:${key}`, value),
};
// Match-all variant of the single-token regex, for scanning copied selections.
const TOKEN_GLOBAL = new RegExp(TOKEN_RE.source, 'g');

function insertText(el: HTMLElement, text: string, restoreSelection?: () => void): void {
  if (!el.isConnected) return;
  el.focus();
  // Some sites (e.g. GitHub Copilot) select the whole field on programmatic
  // focus. Collapse any active selection first so we append at the caret
  // instead of overwriting the user's existing text.
  if (restoreSelection) {
    restoreSelection();
  } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    if (el.selectionStart !== el.selectionEnd) {
      const caret = el.selectionEnd ?? el.value.length;
      el.setSelectionRange(caret, caret);
    }
  } else {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
      // Rich editors (e.g. Kimi's Lexical) drop the selection when focus moves
      // to our overlay, leaving execCommand nowhere to insert. Restore a caret
      // at the end of the editor.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } else if (!sel.isCollapsed) {
      sel.collapseToEnd();
    }
  }

  // Slate editors (e.g. Discord, Notion) keep their own model and ignore
  // execCommand inserts — the text appears but the message stays unsendable.
  // Feed them a synthetic paste instead, which their paste handler reconciles
  // into editor state. (Our guard ignores it: it's not a trusted event.)
  const slate = el.closest('[data-slate-editor="true"]');
  if (slate) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const handled = !slate.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      if (handled) return; // editor consumed the paste
    } catch {
      // DataTransfer/ClipboardEvent unavailable — fall through to execCommand.
    }
  }

  document.execCommand('insertText', false, text);
}

// Content scripts from the same extension share one isolated-world `window`, so a
// dedicated per-site guard marks it here and the catch-all fallback guard checks it
// at paste time — preventing a double overlay on the 19 supported sites without
// maintaining an exclude-list.
const DEDICATED_FLAG = '__secureintentDedicated__';
function markDedicated(): void {
  (window as unknown as Record<string, boolean>)[DEDICATED_FLAG] = true;
}
function dedicatedActive(): boolean {
  return Boolean((window as unknown as Record<string, boolean>)[DEDICATED_FLAG]);
}

export async function createPasteGuard(
  ctx: ContentScriptContext,
  config: SiteConfig,
): Promise<void> {
  const isFallback = config.siteKey === 'fallback';
  if (!isFallback) markDedicated(); // synchronous: runs before the awaits below

  let runtime = createGuardRuntime(DEFAULT_BUNDLE, config, location.hostname);
  let consented = false;
  let enabled = true;
  let initialized = false;
  let disposed = false;
  let initialization: Promise<void> = Promise.resolve();
  let entitlementReady: Promise<void> = Promise.resolve();
  let saltPromise: ReturnType<typeof getOrCreateSalt> | undefined;
  type Interaction = { phase: 'pending' | 'warning' | 'inserting'; remove?: () => void };
  let active: Interaction | null = null;
  const disposers: (() => void)[] = [];
  const origin = location.origin;
  const memVault = new Map<string, string>();

  // Register on WINDOW before any asynchronous initialization. Window capture
  // precedes document capture; document_start alone did not stop page listeners
  // reading the raw clipboard before the old document-level guard ran.
  ctx.addEventListener(
    window,
    'paste',
    async (event) => {
      const e = event as ClipboardEvent;
      let recoverPaste: (() => void) | null = null;
      let finish = () => {};
      try {
        if (disposed || !e.isTrusted) return;
        if (isFallback && dedicatedActive()) return; // a dedicated guard owns this site
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (!text) return;
        const stop = () => {
          e.preventDefault();
          e.stopImmediatePropagation();
        };
        // A second paste must not reach page listeners, even when focus is now
        // on a dialog button rather than the original editor. Retain only paste #1.
        if (active) {
          stop();
          return;
        }
        if (initialized && (!enabled || runtime.bundle.killSwitch)) return;
        // composedPath is only populated during dispatch: save it before waiting.
        const path = e.composedPath();
        const selector = initialized
          ? runtime.inputSelector
          : `${runtime.inputSelector ?? ''}, ${DEFAULT_BUNDLE.sites.fallback.inputSelector}`.replace(
              /^, /,
              '',
            );
        const input = selector ? findComposer(path, selector) : null;
        if (!input) return;
        const restoreSelection = capturePasteSelection(input);
        const insert = (value: string) => insertText(input, value, restoreSelection);
        const interaction: Interaction = { phase: 'pending' };
        const current = () => !disposed && active === interaction;
        finish = () => {
          if (active !== interaction) return;
          active = null;
          interaction.remove?.();
        };
        const intercept = () => {
          stop();
          active = interaction;
        };
        let heldAtStartup = false;
        if (!initialized) {
          intercept();
          heldAtStartup = true;
          await initialization;
          if (!current()) return;
          if (
            !enabled ||
            runtime.bundle.killSwitch ||
            !runtime.inputSelector ||
            !findComposer(path, runtime.inputSelector)
          ) {
            insert(text);
            finish();
            return;
          }
        }
        const {
          bundle,
          policy,
          policyBlockedHost,
          allowRawPaste,
          patterns,
          ghostPatterns,
          ghostMin,
        } = runtime;
        const act = (action: () => void) => {
          if (!current() || interaction.phase === 'inserting') return;
          interaction.phase = 'inserting';
          try {
            action();
          } catch (err) {
            siError(config.name, 'paste action failed', err);
          } finally {
            finish();
          }
        };

        // Rehydrate: if the pasted text carries our tokens, prompt to swap them
        // back to the real secrets at insert time (or keep the tokens / cancel).
        // The secret stays out of the OS clipboard — it only ever materializes on
        // insert. Fails open on any error. Rehydrate is a Pro feature: without the
        // entitlement, skip the prompt entirely and let the tokens paste as-is.
        // Never offered on a policy-blocked host — restoring a real secret into a
        // destination the team forbids is the one thing that rule prohibits. The
        // inert tokens themselves may still paste; they carry nothing.
        if (!policyBlockedHost && hasFeatureCached('rehydrate') && TOKEN_RE.test(text)) {
          const tokens = new Set(text.match(TOKEN_GLOBAL) ?? []);
          let restored = text;
          let known = 0;
          for (const token of tokens) {
            const secret = memVault.get(token);
            if (secret !== undefined) {
              restored = restored.split(token).join(secret);
              known++;
            }
          }
          if (known > 0) {
            intercept();
            const overlay = await mountOverlay(ctx, {
              site: config.name,
              text,
              detections: [],
              rehydrate: { tokenCount: known },
              onAction: (action) =>
                act(() => {
                  if (action === 'rehydrate') insert(restored);
                  else if (action === 'paste') insert(text); // keep tokens as-is
                  // cancel → drop the paste entirely
                  siDebug(config.name, 'rehydrate prompt', { action, tokens: known });
                }),
            });
            if (!current()) {
              overlay.remove();
              return;
            }
            interaction.remove = () => overlay.remove();
            interaction.phase = 'warning';
            return;
          }
          // Unknown/expired tokens aren't secrets — fall through to normal handling.
        }

        // Large pastes look like log/terminal dumps: take the aggressive Ghost
        // path (expanded ruleset + summary overlay) instead of the per-finding one.
        const ghostMode = text.length >= ghostMin;
        const tDetect = performance.now();
        const detections = detectSecrets(text, ghostMode ? ghostPatterns : patterns);
        const detectMs = elapsedMs(tDetect);
        // A blocked destination is about the SITE, not the secret: the admin is
        // told "the extension refuses every paste, whether or not it finds a
        // secret", so a clean paste must be stopped here too. Letting it through
        // would quietly break the promise the console makes to whoever set the
        // rule — and these are the sites a team has decided to feed nothing.
        if (detections.length === 0 && !policyBlockedHost) {
          if (heldAtStartup) {
            insert(text);
            finish();
          }
          return;
        }

        intercept();
        if (allowRawPaste)
          recoverPaste = () => {
            if (current()) insert(text);
          };
        // Show the actual secret warning for this paste. Extracted so the
        // consent gate can call it after the user agrees (first-paste consent).
        const showWarning = async () => {
          await entitlementReady;
          if (!current()) return;
          recordBlocked(detections.length); // popup total; on-device only
          // per-tab action badge (background owns browser.action)
          browser.runtime
            .sendMessage({ type: 'si-detected', count: detections.length })
            .catch(() => {});

          // Feature-hook seam: registered features observe detections (metadata
          // only — raw text is never passed). Fire-and-forget.
          const featureCtx = {
            site: config.name,
            siteKey: config.siteKey,
            detectionCount: detections.length,
            types: detections.map((d) => d.type),
            labels: detections.map((d) => d.label),
          };
          notifyDetections(featureCtx);

          // Telemetry is per-finding (one fingerprint each). Ghost pastes can hold
          // hundreds of findings, so telemetry is skipped for them in this build.
          const fingerprintsPromise = ghostMode
            ? null
            : Promise.all(
                detections.map(async (d) => {
                  saltPromise ??= getOrCreateSalt(browserStore);
                  const fingerprint = await computeFingerprint(d.match, await saltPromise);
                  siDebug(config.name, 'fingerprint', { label: d.label, fingerprint });
                  return { fingerprint, type: d.type, label: d.label };
                }),
              ).catch(
                (
                  err,
                ): {
                  fingerprint: Fingerprint;
                  type: (typeof detections)[number]['type'];
                  label: string;
                }[] => {
                  siError(config.name, 'fingerprint error, telemetry suppressed', err);
                  return [];
                },
              );

          // Gate the pro action for this overlay. Ghost pastes need the `ghost`
          // feature (Pro-only). Standard anonymise is free with a monthly quota,
          // then Pro — the status below reflects Pro OR remaining free allowance.
          const snapshot = getEntitlementSnapshot();
          const quota = ghostMode ? null : await getAnonymizeStatus(snapshot);
          if (!current()) return;
          const proAction = ghostMode
            ? hasFeatureCached('ghost')
            : Boolean(quota && (quota.unlimited || quota.remaining > 0));
          // "Spent your free allowance" is a different situation from "never had
          // this feature", so the overlay is told which one it is: a user at 0/10
          // needs the reset date, not a plain Pro badge.
          const quotaExhausted =
            quota && !quota.unlimited && quota.remaining <= 0
              ? { limit: quota.limit, resetsOn: formatQuotaReset() }
              : undefined;

          const tMount = performance.now();
          const overlay = await mountOverlay(ctx, {
            site: config.name,
            text,
            detections,
            summary: ghostMode ? summarize(detections) : undefined,
            pro: proAction,
            quotaExhausted,
            // Team policy: a blocked destination gets the notice view (no paste
            // route at all); blockInsteadOfWarn just drops "Paste anyway".
            policyBlock: policyBlockedHost ? { host: location.hostname } : undefined,
            blockRawPaste: policy.blockInsteadOfWarn,
            onAction: (action) =>
              act(() => {
                if (action === 'upgrade') {
                  // Hand off to the background to open the account page — the one
                  // place an already-installed user can actually buy or manage a plan.
                  browser.runtime.sendMessage({ type: 'si-open-upgrade' }).catch(() => {});
                  return;
                }
                if (action === 'rehydrate') return; // only the rehydrate overlay emits this
                // `allowRawPaste` is re-checked here, not just in the UI: the
                // policy has to hold even if the overlay were driven some other
                // way. Under a block the paste is simply dropped (= cancel).
                if (action === 'paste') {
                  if (allowRawPaste) insert(text);
                } else if (action === 'sanitize' && proAction && !policyBlockedHost) {
                  // Ghost: strip every finding to a typed placeholder. Irreversible.
                  insert(sanitize(text, detections));
                } else if (action === 'redact' && proAction && !policyBlockedHost) {
                  // Count this Anonymise & Paste against the monthly quota (no-op for
                  // Pro). Fire-and-forget — canAnonymize() already gated the action.
                  consumeAnonymize(snapshot).catch(() => {});
                  // Dehydrate: replace secrets with reversible tokens and stash the
                  // token→secret map so a later paste can rehydrate them.
                  const { text: masked, entries } = tokenizeSecrets(text, detections);
                  insert(masked);
                  for (const { token, secret } of entries) memVault.set(token, secret); // sync read path
                  vaultPut(sessionStore, origin, entries, Date.now()).catch((err) =>
                    siError(config.name, 'vault put failed', err),
                  );
                }
                notifyAction({ ...featureCtx, action }); // pro: audit log / team report
                // We showed a warning for this copy, so the desktop app — if the
                // person runs it and has paired it — should not raise its own for
                // the same one. Only the hash travels, computed here so the pasted
                // text never crosses between extension contexts, and the background
                // drops it entirely when the bridge is off.
                browser.runtime
                  .sendMessage({ type: 'si-bridge-handled', hash: contentHash(text).toString() })
                  .catch(() => {});
                if (!ghostMode && action !== 'sanitize' && fingerprintsPromise) {
                  // A refused "paste" inserted nothing, so it is reported as
                  // cancelled — never as paste_anyway, which would tell the team's
                  // dashboard a secret went through when it did not.
                  const telemetryAction =
                    action === 'paste' && !allowRawPaste ? 'cancelled' : ACTION_BY_OVERLAY[action];
                  fingerprintsPromise.then((dets) => {
                    if (dets.length === 0) return;
                    sendTelemetry(
                      buildEvent({
                        site: config.name,
                        policyVersion: bundle.version,
                        detections: dets,
                        action: telemetryAction,
                        plan: snapshot.plan,
                        source: snapshot.source,
                        signedIn: snapshot.signedIn,
                        businessDomain: snapshot.businessDomain,
                        orgId: snapshot.orgId,
                        actorId: snapshot.actorId,
                      }),
                    );
                  });
                }
              }),
          });
          if (!current()) {
            overlay.remove();
            return;
          }
          interaction.remove = () => overlay.remove();
          interaction.phase = 'warning';

          siDebug(config.name, 'paste blocked', {
            secrets: detections.length,
            types: detections.map((d) => d.type),
            detectMs,
            mountMs: elapsedMs(tMount),
          });
        };

        // Blocking consent gate: on the first paste that would warn, require the
        // user to accept Terms & Privacy before the extension protects anything.
        if (!consented) {
          const gate = await mountConsentGate(ctx, {
            onAgree: () => {
              if (!current() || interaction.phase !== 'warning') return;
              interaction.phase = 'pending';
              acceptTerms().catch((err) => siError(config.name, 'consent save failed', err));
              gate.remove();
              interaction.remove = undefined;
              void showWarning().catch((err) => {
                siError(config.name, 'warning after consent failed', err);
                try {
                  recoverPaste?.();
                } finally {
                  finish();
                }
              });
            },
            onCancel: () => act(() => {}),
          });
          if (!current()) {
            gate.remove();
            return;
          }
          interaction.remove = () => gate.remove();
          interaction.phase = 'warning';
          return;
        }

        await showWarning();
      } catch (err) {
        siError(config.name, 'paste guard error, allowing paste', err);
        try {
          recoverPaste?.(); // fail open only for the still-active interaction
        } finally {
          finish();
        }
      }
    },
    { capture: true },
  );

  // Local settings/config readiness is independent of auth, telemetry, and vault
  // I/O. An early paste is already stopped while this promise is pending.
  initialization = (async () => {
    const [bundle, storedEnabled, storedConsent] = await Promise.all([
      getActiveBundle(),
      isEnabled(),
      isConsentAccepted(),
    ]);
    if (disposed) return;
    runtime = createGuardRuntime(bundle, config, location.hostname);
    enabled = storedEnabled;
    consented = storedConsent;
    disposers.push(
      enabledItem.watch((value) => {
        enabled = value ?? true;
      }),
      consentItem.watch((value) => {
        consented = consentSatisfied(value);
      }),
    );
  })()
    .catch((err) => siError(config.name, 'using offline guard after initialization failure', err))
    .finally(() => {
      initialized = true;
      if (!disposed) siDebug(config.name, 'guard active', { selector: runtime.inputSelector });
    });
  entitlementReady = initEntitlementCache()
    .then((stop) => {
      if (disposed) stop();
      else disposers.push(stop);
    })
    .catch((err) => siError(config.name, 'entitlement initialization failed', err));
  vaultSnapshot(sessionStore, origin, Date.now())
    .then((snap) => {
      if (!disposed)
        for (const [token, secret] of Object.entries(snap)) memVault.set(token, secret);
    })
    .catch((err) => siError(config.name, 'vault hydrate failed', err));
  ctx.onInvalidated?.(() => {
    disposed = true;
    active?.remove?.();
    active = null;
    for (const stop of disposers) stop();
    memVault.clear();
  });
  await initialization;
}
