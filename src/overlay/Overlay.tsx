import { useEffect, useState } from 'react';
import { Logo } from '@/components/Logo';
import {
  type Detection,
  type GhostSummary,
  locateInText,
  type SecretLocation,
} from '@/lib/detection';

export type OverlayAction = 'paste' | 'redact' | 'cancel' | 'sanitize' | 'upgrade' | 'rehydrate';

/**
 * Marks a finding that came from a rule the team's own admin added, so a member
 * can tell "my company flagged this" from "SecureIntent flagged this". Shown
 * only on `origin === 'team'` — the default catalogue carries no origin and gets
 * no badge. Static text: it never renders any part of the matched secret.
 */
function TeamRuleTag() {
  return (
    <span className="si-team-tag" title="Detected by a rule your team's admin added">
      Team rule
    </span>
  );
}

export interface OverlayProps {
  site: string;
  text: string;
  detections: Detection[];
  /** Full count; worker-backed previews are bounded independently of protection. */
  findingCount?: number;
  locations?: SecretLocation[];
  /** When set, render the compact Ghost summary instead of a per-finding list. */
  summary?: GhostSummary;
  /** When set, render the rehydrate prompt (pasted text contains our tokens). */
  rehydrate?: { tokenCount: number };
  /** Whether the user's plan unlocks the pro actions (anonymize / sanitize). */
  pro?: boolean;
  /**
   * Set when the free monthly Anonymise & Paste allowance is spent (`pro` is
   * false for a different reason than "never had it"). Carries the limit and the
   * UTC date the allowance comes back, so the dialog can say so instead of
   * showing the same Pro badge as a user who never had the feature.
   */
  quotaExhausted?: { limit: number; resetsOn: string };
  /**
   * Team policy `blockedSites`: this destination is off-limits, so the dialog is
   * a notice with no paste actions at all.
   */
  policyBlock?: { host: string; sensitiveOnly?: boolean };
  /**
   * Team policy `blockInsteadOfWarn`: the warning is a block. Drops "Paste
   * anyway" so the raw text has no route in; anonymise and cancel remain.
   */
  blockRawPaste?: boolean;
  onAction: (action: OverlayAction) => void;
}

export function Overlay({
  site,
  text,
  detections,
  findingCount = detections.length,
  locations,
  summary,
  rehydrate,
  pro = false, // fail-closed: a caller that omits `pro` gets the free (upgrade) UI
  quotaExhausted,
  policyBlock,
  blockRawPaste = false,
  onAction,
}: OverlayProps) {
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onAction('cancel');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onAction]);

  // A blocked destination outranks every other view: there is no outcome here
  // other than dropping the paste, so no view that offers one may render.
  if (policyBlock)
    return (
      <PolicyBlockView
        site={site}
        host={policyBlock.host}
        sensitiveOnly={policyBlock.sensitiveOnly === true}
        findings={findingCount}
        onAction={onAction}
      />
    );

  if (rehydrate)
    return <RehydrateView site={site} tokenCount={rehydrate.tokenCount} onAction={onAction} />;

  if (summary)
    return (
      <GhostSummaryView
        site={site}
        summary={summary}
        pro={pro}
        blockRawPaste={blockRawPaste}
        onAction={onAction}
      />
    );

  return (
    <div className="si-scrim" onClick={() => onAction('cancel')}>
      <div
        className="si-hud"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Secret detected before pasting into ${site}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="si-top">
          <span className="si-brand">
            <Logo size={22} />
            <span className="si-wordmark">
              SecureIntent<span className="si-ai">.ai</span>
            </span>
          </span>
          <button
            type="button"
            className="si-x"
            aria-label="Cancel"
            onClick={() => onAction('cancel')}
          >
            &times;
          </button>
        </div>

        <div className="si-rule" />

        <ul className="si-findings">
          {detections.map((d, i) => {
            const open = expanded === i;
            const loc = locations?.[i] ?? locateInText(text, d);
            return (
              <li key={i} className="si-finding">
                <button
                  type="button"
                  className="si-finding-row"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : i)}
                >
                  <span className="si-sev" aria-hidden="true" />
                  <span className="si-finding-name">{d.label}</span>
                  {d.origin === 'team' && <TeamRuleTag />}
                  <span className="si-finding-meta">
                    line {loc.line} · {d.match.length} chars
                  </span>
                  <svg
                    className={`si-chevron ${open ? 'is-open' : ''}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M6 9l6 6 6-6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                {open && (
                  <div className="si-finding-detail">
                    <code className="si-snippet">{loc.snippet}</code>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {findingCount > detections.length && (
          <p className="si-policy-note">
            Showing {detections.length} of {findingCount} findings. Anonymization still covers all
            findings.
          </p>
        )}

        {blockRawPaste && (
          <p className="si-policy-note">
            Your team's policy blocks pasting secrets — anonymise it or cancel.
          </p>
        )}

        {!pro && quotaExhausted && (
          <p className="si-quota-note">
            You've used all {quotaExhausted.limit} free Anonymise &amp; Paste this month. Your
            allowance comes back on <b>{quotaExhausted.resetsOn}</b> (UTC) — Pro is unlimited.
          </p>
        )}

        <div className="si-actions">
          <button type="button" className="si-btn si-btn-ghost" onClick={() => onAction('cancel')}>
            Cancel
          </button>
          {!blockRawPaste && (
            <button
              type="button"
              className="si-btn si-btn-danger"
              onClick={() => onAction('paste')}
            >
              Paste anyway
            </button>
          )}
          {pro ? (
            <button type="button" className="si-btn si-btn-mint" onClick={() => onAction('redact')}>
              Paste anonymously
            </button>
          ) : (
            <button
              type="button"
              className="si-btn si-btn-locked"
              onClick={() => onAction('upgrade')}
              title={
                quotaExhausted
                  ? `Your free allowance comes back on ${quotaExhausted.resetsOn} (UTC)`
                  : 'Upgrade to anonymize secrets before pasting'
              }
            >
              {quotaExhausted ? 'Upgrade for unlimited' : 'Paste anonymously · Pro'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Team policy `blockedSites`: the destination itself is off-limits, so this is a
 * notice rather than a choice — the only button dismisses it. Named the host so
 * the member can see which rule caught them instead of guessing.
 */
function PolicyBlockView({
  site,
  host,
  sensitiveOnly,
  findings,
  onAction,
}: {
  site: string;
  host: string;
  sensitiveOnly: boolean;
  findings: number;
  onAction: (action: OverlayAction) => void;
}) {
  return (
    <div className="si-scrim" onClick={() => onAction('cancel')}>
      <div
        className="si-hud"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Paste into ${site} blocked by your team's policy`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="si-top">
          <span className="si-brand">
            <Logo size={22} />
            <span className="si-wordmark">
              SecureIntent<span className="si-ai">.ai</span>
            </span>
          </span>
          <span className="si-policy-tag">Team policy</span>
        </div>

        <div className="si-rule" />

        <p className="si-ghost-lead">
          {sensitiveOnly ? (
            <>
              Your team blocks sensitive pastes into <b>{host}</b>. This paste contained {findings}{' '}
              sensitive {findings === 1 ? 'item' : 'items'} and was not inserted.
            </>
          ) : (
            <>
              Your team blocks pasting into <b>{host}</b>. This paste was not inserted.
            </>
          )}
        </p>
        <p className="si-policy-note">Ask your workspace admin if you need access here.</p>

        <div className="si-actions">
          <button type="button" className="si-btn si-btn-ghost" onClick={() => onAction('cancel')}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

/** Prompt shown when a paste carries our anonymized tokens: restore or keep them. */
function RehydrateView({
  site,
  tokenCount,
  onAction,
}: {
  site: string;
  tokenCount: number;
  onAction: (action: OverlayAction) => void;
}) {
  const many = tokenCount !== 1;
  return (
    <div className="si-scrim" onClick={() => onAction('cancel')}>
      <div
        className="si-hud"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Restore anonymized secrets before pasting into ${site}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="si-top">
          <span className="si-brand">
            <Logo size={22} />
            <span className="si-wordmark">
              SecureIntent<span className="si-ai">.ai</span>
            </span>
          </span>
          <button
            type="button"
            className="si-x"
            aria-label="Cancel"
            onClick={() => onAction('cancel')}
          >
            &times;
          </button>
        </div>

        <div className="si-rule" />

        <p className="si-ghost-lead">
          This paste contains {tokenCount} anonymized {many ? 'tokens' : 'token'}. Restore the
          original {many ? 'secrets' : 'secret'} before pasting?
        </p>

        <div className="si-actions">
          <button type="button" className="si-btn si-btn-ghost" onClick={() => onAction('cancel')}>
            Cancel
          </button>
          <button type="button" className="si-btn si-btn-ghost" onClick={() => onAction('paste')}>
            Paste as-is
          </button>
          <button
            type="button"
            className="si-btn si-btn-mint"
            onClick={() => onAction('rehydrate')}
          >
            Rehydrate
          </button>
        </div>
      </div>
    </div>
  );
}

/** Compact summary for large (Ghost) pastes: counts by category, one strip action. */
function GhostSummaryView({
  site,
  summary,
  pro,
  blockRawPaste,
  onAction,
}: {
  site: string;
  summary: GhostSummary;
  pro: boolean;
  blockRawPaste: boolean;
  onAction: (action: OverlayAction) => void;
}) {
  return (
    <div className="si-scrim" onClick={() => onAction('cancel')}>
      <div
        className="si-hud"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Sensitive data detected in a large paste into ${site}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="si-top">
          <span className="si-brand">
            <Logo size={22} />
            <span className="si-wordmark">
              SecureIntent<span className="si-ai">.ai</span>
            </span>
          </span>
          <button
            type="button"
            className="si-x"
            aria-label="Cancel"
            onClick={() => onAction('cancel')}
          >
            &times;
          </button>
        </div>

        <div className="si-rule" />

        <div className="si-feature">
          <span className="si-feature-ic">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
              <path
                d="M5 20V10a7 7 0 0 1 14 0v10l-2.3-1.6L14.4 20 12 18.3 9.6 20 7.3 18.4 5 20z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <circle cx="9.5" cy="10.8" r="1" fill="currentColor" />
              <circle cx="14.5" cy="10.8" r="1" fill="currentColor" />
            </svg>
          </span>
          <span className="si-feature-name">Ghost Log Sanitiser</span>
          {!pro && <span className="si-feature-pro">Pro</span>}
        </div>

        <p className="si-ghost-lead">
          Found {summary.total} sensitive {summary.total === 1 ? 'item' : 'items'} in this large
          paste:
        </p>
        <ul className="si-ghost-counts">
          {summary.items.map((it) => (
            <li key={it.label} className="si-ghost-count">
              <span className="si-ghost-num">{it.count}</span>
              <span className="si-ghost-label">{it.label}</span>
              {it.origin === 'team' && <TeamRuleTag />}
            </li>
          ))}
        </ul>

        {blockRawPaste && (
          <p className="si-policy-note">
            Your team's policy blocks pasting secrets — sanitize it or cancel.
          </p>
        )}

        <div className="si-actions">
          <button type="button" className="si-btn si-btn-ghost" onClick={() => onAction('cancel')}>
            Cancel
          </button>
          {!blockRawPaste && (
            <button
              type="button"
              className="si-btn si-btn-danger"
              onClick={() => onAction('paste')}
            >
              Paste anyway
            </button>
          )}
          {pro ? (
            <button
              type="button"
              className="si-btn si-btn-mint"
              onClick={() => onAction('sanitize')}
            >
              Sanitize &amp; paste
            </button>
          ) : (
            <button
              type="button"
              className="si-btn si-btn-locked"
              onClick={() => onAction('upgrade')}
              title="Upgrade to sanitize large pastes"
            >
              Sanitize &amp; paste · Pro
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
