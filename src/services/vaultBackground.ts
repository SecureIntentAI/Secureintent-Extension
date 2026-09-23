import { browser } from '#imports';
import type { VaultEntry } from '@/lib/detection';
import { type VaultStore, vaultPut, vaultSnapshot, vaultSweep } from '@/lib/vault';

const store: VaultStore = {
  get: async (key) => {
    const value = (await browser.storage.session.get(key))[key];
    return typeof value === 'string' ? value : undefined;
  },
  set: async (key, value) => {
    await browser.storage.session.set({ [key]: value });
  },
};
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>) {
  const next = tail.then(work, work);
  tail = next.catch(() => undefined);
  return next;
}
export function handleVaultMessage(message: { type: string; entries?: VaultEntry[] }, url: string) {
  return serial(async () => {
    const source = new URL(url);
    if (!['http:', 'https:'].includes(source.protocol)) throw new Error('Invalid vault origin');
    if (message.type === 'si-vault-put') {
      const entries = message.entries;
      if (
        !Array.isArray(entries) ||
        entries.length > 100_000 ||
        entries.some(
          (e) =>
            !e ||
            typeof e.token !== 'string' ||
            !/^⟦SI:[0-9a-f]{8}⟧$/.test(e.token) ||
            typeof e.secret !== 'string',
        ) ||
        JSON.stringify(entries).length > 4_000_000
      )
        throw new Error('Invalid vault data');
      await vaultSweep(store, source.origin, Date.now());
      await vaultPut(store, source.origin, entries, Date.now());
      return { ok: true };
    }
    await vaultSweep(store, source.origin, Date.now());
    return { ok: true, entries: await vaultSnapshot(store, source.origin, Date.now()) };
  });
}
export function sweepVaults() {
  return serial(async () => {
    const all = await browser.storage.session.get(null);
    for (const key of Object.keys(all)) {
      if (key.startsWith('si_vault:'))
        await vaultSweep(store, key.slice('si_vault:'.length), Date.now());
    }
  });
}
export function installVaultBackground() {
  // Content scripts access only their sender-derived origin through messages.
  void browser.storage.session
    .setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch(() => {});
  browser.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'si-vault-put' && message?.type !== 'si-vault-read') return false;
    if (sender.id !== browser.runtime.id || sender.tab?.id == null || !sender.url) {
      respond({ ok: false });
      return false;
    }
    void handleVaultMessage(message, sender.url).then(respond, () => respond({ ok: false }));
    return true;
  });
  browser.alarms.create('si-vault-expiry', { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'si-vault-expiry') void sweepVaults().catch(() => {});
  });
  void sweepVaults().catch(() => {});
}
