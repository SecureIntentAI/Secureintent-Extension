import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  srcDir: 'src',
  publicDir: 'src/public',
  outDir: process.env.WXT_E2E === '1' ? 'dist-e2e' : 'dist',
  // Rasterizes src/assets/icon.svg into all manifest icon sizes at build time.
  autoIcons: {
    baseIconPath: 'assets/icon.svg',
    sizes: [128, 96, 48, 32, 16],
  },
  // Vite emits <link rel="modulepreload" crossorigin> for split chunks. On a
  // chrome-extension:// page Chrome fetches that hint in a different world than
  // the real module import, so it can never be used and the browser logs
  // "cross-world extension resource mismatch" against every extension page.
  // The chunks are local files loaded through the import graph anyway, so the
  // hint buys nothing here — drop it and the warning goes with it.
  vite: () => ({ build: { modulePreload: false } }),

  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';
    // Local end-to-end testing: when the build is pointed at a localhost Worker or
    // a locally served landing page, the extension needs permission to reach them
    // (fetch the API, read the creator cookie). Never present in a shipped build —
    // these env vars are unset in CI and in a normal `pnpm build`.
    const localHosts = [process.env.WXT_API_BASE, process.env.WXT_WEB_APP_URL]
      .filter((u): u is string => Boolean(u?.startsWith('http://localhost')))
      .map((u) => `${new URL(u).origin}/*`);
    return {
      // Chrome-only: pins the extension ID (ejdhcakapnkbmfihgoamdnajgimhemof) so
      // chrome-extension:// origins stay stable for Clerk allowed-origins +
      // CLERK_AUTHORIZED_PARTIES. Firefox ignores `key`, so omit it there (its
      // stable identity comes from browser_specific_settings.gecko.id below).
      ...(isFirefox
        ? {}
        : {
            minimum_chrome_version: '109', // private offscreen Worker host
            key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6OipE3Igc3/YZr0H+I3aWot4xOqHvMyGHWuoyxpfIv6gISMyk2tWNjqAmSeMULt1EBgXvv44xdFPfWP8KUtbcr3tEgADXWFB0L6zI6GbFVdtm4Y3T/iXGLGQ3SN+yZQFPHQppY/NtXhM7d0LkAfXgL/pE6BySJzD1k8O/xlmRBuTjIOG538B5atOQO//YTSVDkKkJH9ZhOPqsbdyq5qc3R01szbD1oa2cBcteNpseI0Xp0X1LJLCq2ESfZKYxvzYJAaE7bQTcof4WUQL87gKN87NR2fQzIlwmYDg6n4BHDfwuUi3fNyuIlOemw9ugf+bSQYlsgqxdIT80GRW+M5eVwIDAQAB',
          }),
      name: 'SecureIntent',
      description:
        'Blocks secret pastes locally. Business teams receive limited AI-service security metadata—never prompts, pasted text, or secrets.',
      // activeTab: read the current tab's URL (on popup open) to show which site
      // is being protected. No broad tabs permission needed.
      // cookies: required by @clerk/chrome-extension to read/sync the Clerk session
      // from the Sync Host (secureintent.ai) and the Frontend API domain.
      permissions: [
        'storage',
        'alarms',
        'activeTab',
        'cookies',
        ...(isFirefox ? [] : ['offscreen', 'scripting']),
      ],
      // Privileged access to our Worker so the background config sync + content-script
      // telemetry fetches bypass page CORS, plus the Clerk Frontend API for auth.
      host_permissions: [
        'https://api.secureintent.ai/*',
        // Sync Host — the web app whose Clerk session the extension mirrors.
        'https://secureintent.ai/*',
        'https://*.clerk.accounts.dev/*',
        'https://clerk.secureintent.ai/*',
        // Needed so an already-open tab can receive the paste guard on install.
        // The content scripts already run on these pages after a reload.
        ...(isFirefox ? [] : ['http://*/*', 'https://*/*']),
        ...localHosts,
      ],
      // Firefox-only: AMO requires a stable add-on id, a minimum-version floor
      // (storage.session needs FF 115+), and — for all new add-ons — the
      // data_collection_permissions key. Core protection collects nothing
      // ("required: none"); telemetry is opt-in behind the in-product consent gate,
      // so it's declared as optional: a salted SHA-256 fingerprint + detection
      // metadata (technical/interaction) and the paste site's domain (website
      // activity). Raw pasted text NEVER leaves the device (never websiteContent).
      // The key is read only by FF 140+; older Firefox ignores it (hence the min
      // stays at 115 for reach — AMO treats the version note as a warning, not an
      // error). Note: `technicalAndInteraction` is valid only in `optional`.
      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'secureintent@secureintent.ai',
                strict_min_version: '115.0',
                data_collection_permissions: {
                  required: ['none'],
                  optional: ['technicalAndInteraction', 'websiteActivity'],
                },
              },
            },
          }
        : {}),
    };
  },
});
