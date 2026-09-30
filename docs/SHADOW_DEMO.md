# Live Shadow AI demo

## Build and open

From the extension checkout, run `pnpm build:demo` to create
`dist-demo/chrome-mv3`, or `pnpm build:e2e:shadow` to create the same demo
workflow at `dist-e2e/chrome-mv3` for the existing unpacked E2E install path.
Both commands read the current `shadow.html` and `assets/shadow/` from the
sibling `secureintent.ai` checkout. Set `SHADOW_DASHBOARD_SOURCE` to a different
website checkout if needed. Running `pnpm e2e` rebuilds `dist-e2e` as the
automation artifact; rerun `pnpm build:e2e:shadow` afterward before reloading it
for the interactive Shadow AI demo.

1. In the browser's extension manager, enable Developer mode and load unpacked
   `dist-demo/chrome-mv3` or `dist-e2e/chrome-mv3`, according to the build used.
2. Disable your other SecureIntent copy while using the demo, so two paste guards
   do not handle the same paste.
3. Accept the extension's Terms and Privacy notice.
4. Open the popup and select **Live Shadow AI · local demo**.
5. Select **Start recording**, then reload a supported AI tab such as ChatGPT or Claude.
6. Paste ordinary text in that site's composer. Return to the dashboard to see
   its visit, paste count, volume, and service card. Choose **Pastes** on the chart.
   A sensitive paste's final decision also appears in the DLP ledger.
7. Open the service card to change its classification or paste policy.
   Demo policies propagate to existing content scripts through extension storage.

The dashboard starts empty. There are no seeded events or fabricated seats.
`http://127.0.0.1:4173/shadow.html?preview=policy` remains the separate visual
preview with sample data; open the dashboard from the extension for real events.

## Updates and data boundaries

- Storage notifications trigger a refresh after a 100 ms burst-coalescing window.
  This is a scheduling target, not a measured end-to-end latency guarantee.
- Dashboard sections share one snapshot. Unchanged sections are not redrawn.
- A five-second fallback refresh runs while the dashboard is visible; returning
  to the tab refreshes immediately. Failures retain the last data with a stale
  status and retry with backoff.
- **Pause recording** stops new demo observations. **Clear activity** removes
  stored observations but leaves the chosen policies in place.
- Demo data is stored locally, bounded to 5,000 events and a 90-day view. The UI
  reports events dropped at the capacity limit. Counts describe retained events.
- Only catalog-matched HTTPS destinations in non-incognito top-level frames
  contribute events. No prompts, secret values, complete URLs, or seat identity
  are recorded. A paste attempt does not prove a prompt was sent.
- Demo collection requires both Terms acceptance and Start recording. The demo
  build has a separate extension ID, no Clerk sign-in, and routes its regular API
  base to loopback. Demo observations never enter the production upload queue.
- Demo policy writes use separate local storage; they do not replace signed
  production policy bundles or unlock paid entitlements.

## Live organisation dashboard

The authenticated website still uses the Shadow API. It now refreshes every
five seconds while visible, with backoff on failure. Production extension policy
sync remains on its existing five-minute cadence. A local demo does not exercise
cloud ingestion, team tenancy, or production policy distribution.

## Validation for this change

Extension and backend TypeScript compilation and demo packaging completed.
Browser end-to-end event and policy testing remains a manual next step.
