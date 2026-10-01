import { beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { browser } from '#imports';
import { configItem } from '@/lib/config/store';
import { DEFAULT_BUNDLE } from '@/lib/config/default';
import { reportBusinessConnection } from './businessConnection';

const state = vi.hoisted(() => ({consent:true,org:'org_acme' as string|null,token:'synthetic-session'}));
vi.mock('@/lib/consent',()=>({isConsentAccepted:async()=>state.consent}));
vi.mock('@/lib/entitlement',()=>({getActiveEntitlement:async()=>({org:state.org?{id:state.org}:null})}));
vi.mock('./entitlementBackground',()=>({getClerkToken:async()=>state.token}));
beforeEach(()=>{fakeBrowser.reset();state.consent=true;state.org='org_acme';
  vi.spyOn(browser.runtime,'getManifest').mockReturnValue({manifest_version:3,name:'SecureIntent',version:'1.2.0'});
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({connected:true})));});
test('reports only identity-bound connection metadata and a stable installation ID',async()=>{
  await configItem.setValue({...DEFAULT_BUNDLE,policy:{orgId:'org_acme',blockInsteadOfWarn:false,requireSessionLock:false,blockedSites:[]},policyVersion:4});
  await reportBusinessConnection();await reportBusinessConnection();
  const calls=vi.mocked(fetch).mock.calls;
  const a=JSON.parse(String(calls[0][1]?.body));const b=JSON.parse(String(calls[1][1]?.body));
  expect(a).toMatchObject({expectedOrgId:'org_acme',extensionVersion:'1.2.0',appliedPolicyVersion:4});
  expect(a.installationId).toBe(b.installationId);
  expect(a).not.toHaveProperty('email');expect(a).not.toHaveProperty('userId');
  expect(calls[0][1]?.headers).toMatchObject({Authorization:'Bearer synthetic-session'});
});
test('does not report unconsented or individual accounts',async()=>{
  state.consent=false;await reportBusinessConnection();state.consent=true;state.org=null;
  await reportBusinessConnection();expect(fetch).not.toHaveBeenCalled();
});
test('cannot acknowledge another organizations cached policy',async()=>{
  await configItem.setValue({...DEFAULT_BUNDLE,policy:{orgId:'org_other',blockInsteadOfWarn:false,requireSessionLock:false,blockedSites:[]},policyVersion:99});
  await reportBusinessConnection();
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).appliedPolicyVersion).toBe(0);
});
