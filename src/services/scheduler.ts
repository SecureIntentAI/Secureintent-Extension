import { type SyncResult, syncConfig } from './configService';

export const SYNC_ALARM = { name: 'si-config-sync', periodInMinutes: 120 };
// Shadow policy writes are applied through the same signed config bundle. Keep
// the normal entitlement refresh cadence at two hours, but distribute service
// policy changes from the dashboard within five minutes.
export const SHADOW_POLICY_SYNC_ALARM = { name: 'si-shadow-policy-sync', periodInMinutes: 5 };

export async function handleRefreshMessage(msg: unknown): Promise<SyncResult | null> {
  if (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: string }).type === 'si-refresh-config'
  ) {
    return syncConfig();
  }
  return null;
}
