// Clerk publishable key — safe to ship in the client (it is not a secret).
// Provided at build time via WXT env: set WXT_CLERK_PUBLISHABLE_KEY in ext/.env.
export const CLERK_PUBLISHABLE_KEY =
  import.meta.env.WXT_E2E === '1' ? '' : (import.meta.env.WXT_CLERK_PUBLISHABLE_KEY ?? '');

/** The custom Clerk JWT template that carries email + public_metadata claims. */
export const CLERK_JWT_TEMPLATE = 'secureintent';

// Sync Host: the domain the Clerk **Frontend API** runs on — NOT the app root.
// In production with a custom domain that's `https://clerk.<domain>`; the prod
// session cookie lives there, so the extension must sync from it (per Clerk's
// chrome-extension Sync Host docs). host_permissions must include this origin.
export const CLERK_SYNC_HOST =
  import.meta.env.WXT_CLERK_SYNC_HOST ?? 'https://clerk.secureintent.ai';

// The web app origin (where account.html + the sign-in UI live). Distinct from
// the Frontend API host above, so ACCOUNT_URL points at the app, not the FAPI.
export const WEB_APP_URL = import.meta.env.WXT_WEB_APP_URL ?? 'https://secureintent.ai';

/**
 * The web account page where users sign in / manage their account + plan, and
 * the **single destination for every upgrade CTA** (popup and overlay alike).
 * The marketing `#tiers` section is for people who don't have the extension yet:
 * its Developer Pro card says "Install SecureIntent", which is a dead end for
 * someone who is already looking at our overlay.
 */
export const ACCOUNT_URL = `${WEB_APP_URL}/account.html`;

/** The team console: seats, members, and what the team's extensions are stopping. */
export const TEAM_URL = `${WEB_APP_URL}/team.html`;

/** True on the Firefox build (MV2). Auth takes the cookie path here, not the SDK. */
export const IS_FIREFOX = import.meta.env.BROWSER === 'firefox';

/** Auth is set up (a publishable key was baked in). True on BOTH browsers. */
export const isAuthEnabled = () => CLERK_PUBLISHABLE_KEY.length > 0;

/**
 * Whether to use the `@clerk/chrome-extension` SDK (ClerkProvider + in-extension
 * `createClerkClient`). Chrome only. On Firefox the SDK cannot be used:
 *   1. It requires an MV3-style `host_permissions` manifest key; the Firefox build
 *      is MV2 (host perms fold into `permissions`), so `ClerkProvider` throws
 *      "Missing host_permissions entry" and crashes the popup.
 *   2. It mints tokens from the extension origin, and Firefox's random
 *      `moz-extension://<uuid>` origin can't be added to Clerk `allowed_origins`.
 * Firefox instead reads the web-app session token from the cookie and verifies it
 * server-side (no origin check). See docs/FIREFOX_LAUNCH.md §1.
 */
export const isClerkSdkEnabled = () => isAuthEnabled() && !IS_FIREFOX;

/**
 * @deprecated Prefer {@link isAuthEnabled} (auth available) or
 * {@link isClerkSdkEnabled} (Chrome SDK path). Kept for call sites that mean
 * "the Chrome extension SDK is active".
 */
export const isClerkConfigured = isClerkSdkEnabled;
