import { expect, test } from './fixtures';

// Proves the login/logout sync path: when Clerk writes a session key into
// extension storage (as it does on sign-in / sign-out), the background
// auto-refreshes the cached entitlement. Here there is no real Clerk session,
// so the refresh resolves to "signed out" and clears a seeded entitlement —
// demonstrating the storage-change → background-refresh → entitlement-update
// chain that content scripts then observe via storage.watch.

declare const chrome: {
  storage: {
    local: {
      set(i: Record<string, unknown>): Promise<void>;
      get(k: string[]): Promise<Record<string, unknown>>;
    };
  };
};

test('a Clerk session-storage change triggers a background entitlement refresh', async ({
  context,
}) => {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');

  // Seed a cached entitlement blob.
  await sw.evaluate(() =>
    chrome.storage.local.set({ si_entitlement: { blob: { clerkUserId: 'u1' }, signatures: { 'entitlement-2026-11': 'x' } } }),
  );

  // Simulate Clerk writing a session key (what happens on sign-in/out).
  await sw.evaluate(() => chrome.storage.local.set({ __clerk_db_jwt: 'session-changed' }));

  // Background debounces then refreshes; with no real session it clears the blob.
  await expect
    .poll(
      () =>
        sw.evaluate(() =>
          chrome.storage.local.get(['si_entitlement']).then((r) => r.si_entitlement ?? null),
        ),
      { timeout: 10_000 },
    )
    .toBeNull();
});
