import { browser } from '#imports';
import { withDeadline } from '@/lib/async';
import type { VaultEntry } from '@/lib/detection';

export async function storeVaultEntries(entries: VaultEntry[]): Promise<void> {
  const result = await withDeadline(() =>
    browser.runtime.sendMessage({ type: 'si-vault-put', entries }),
  );
  if (!result?.ok) throw new Error('Vault storage unavailable');
}
export async function readVaultEntries(): Promise<Record<string, string>> {
  const result = await withDeadline(() => browser.runtime.sendMessage({ type: 'si-vault-read' }));
  if (!result?.ok || !result.entries) throw new Error('Vault unavailable');
  return result.entries;
}
