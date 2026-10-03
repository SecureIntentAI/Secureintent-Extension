import { collectPolicyReceipts } from './policyReceipts';
import { syncConfig } from './configService';
import { isEnabled } from '@/settings';
import { browser } from '#imports';
import { API_BASE } from '@/lib/api/client';
import { configItem } from '@/lib/config/store';
import { getActiveEntitlement } from '@/lib/entitlement';
import { isConsentAccepted } from '@/lib/consent';
import { withDeadline } from '@/lib/async';
import { getClerkToken } from './entitlementBackground';

let pending: Promise<void> | undefined;
async function report(confirmAfterSync = true): Promise<void> {
  if (!(await isConsentAccepted())) return;
  const entitlement = await getActiveEntitlement();
  if (!entitlement.org) return;
  const orgId = entitlement.org.id;
  const token = await getClerkToken();
  if (!token) return;
  const key = 'si_business_installation';
  const stored = (await browser.storage.local.get(key))[key];
  const installationId = typeof stored === 'string' ? stored : crypto.randomUUID();
  if (stored !== installationId) await browser.storage.local.set({ [key]: installationId });
  const config = await configItem.getValue();
  const version = config?.policy?.orgId === orgId ? config.policyVersion ?? 0 : 0;
  const receipt = await collectPolicyReceipts(orgId,version);
  if (!(await isEnabled()) || config?.killSwitch) receipt.policyState='disabled';
  if (config?.policy?.orgId !== orgId) receipt.policyState='pending';
  const syncState=(await browser.storage.local.get('si_policy_sync_status')).si_policy_sync_status as {status?:string;at:number}|undefined;
  if(syncState?.status==='error' && Date.now()-syncState.at<120_000) receipt.policyState='failed';
  // Identity may change while page acknowledgements are collected.
  if ((await getActiveEntitlement()).org?.id !== orgId) return;
  const serverVersion = await withDeadline(async signal => {
    const response = await fetch(`${API_BASE}/v1/business/connection`, {
      method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({expectedOrgId:orgId,installationId,extensionVersion:browser.runtime.getManifest().version,
        appliedPolicyVersion:version,...receipt}),
      cache:'no-store',redirect:'error',signal,
    });
    if (!response.ok) throw new Error('Connection report unavailable');
    const result = await response.json() as {orgId:string;policyVersion:number};
    if (result.orgId!==orgId) throw new Error('Connection organization mismatch');
    return result.policyVersion;
  });
  await browser.storage.local.set({si_business_connection_status:{at:Date.now(),status:'reported'}});
  if(serverVersion>version && confirmAfterSync) {
    await syncConfig();
    const updated = await configItem.getValue();
    // The first receipt described the old revision. Report again once the
    // signed bundle has been saved so the admin sees the new guard state now,
    // rather than waiting for the next minute alarm.
    if(updated?.policy?.orgId===orgId && (updated.policyVersion ?? 0)>version) await report(false);
  }
}

export function reportBusinessConnection(): Promise<void> {
  if (!pending) pending = report().catch(async () => {
    await browser.storage.local.set({si_business_connection_status:{at:Date.now(),status:"retry_pending"}}).catch(()=>{});
  }).finally(() => { pending=undefined; });
  return pending;
}
