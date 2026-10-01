import { browser } from '#imports';
import { API_BASE } from '@/lib/api/client';
import { withDeadline } from '@/lib/async';
import { isConsentAccepted } from '@/lib/consent';
import { getActiveEntitlement } from '@/lib/entitlement';
import { configItem } from '@/lib/config/store';
import { getClerkToken, refreshEntitlementBg } from './entitlementBackground';
import { syncConfig } from './configService';
import { reportBusinessConnection } from './businessConnection';

let socket: WebSocket | undefined;
let connecting = false;
let generation = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let failures = 0;
let syncing = false;
let dirty = false;

// Coalesce bursts but reconcile again when a save arrives during an in-flight fetch.
async function reconcile() {
  dirty=true;
  if (syncing) return;
  syncing=true;
  try {
    do {
      dirty=false;
      const result=await syncConfig();
      await browser.storage.local.set({si_policy_sync_status:{at:Date.now(),status:result.status}});
      await reportBusinessConnection();
    } while(dirty);
  } finally { syncing=false; }
}

export function stopPolicyStream() {
  generation++;
  clearTimeout(retry); clearInterval(heartbeat);
  retry=undefined; heartbeat=undefined;
  const old=socket; socket=undefined;
  if(old) { old.onclose=null; old.close(); }
}

/** Reconnect also runs from the persisted minute alarm if MV3 suspended the worker. */
export async function ensurePolicyStream(): Promise<void> {
  if (connecting || socket) return;
  connecting=true;
  const turn=generation;
  try {
    if (!(await isConsentAccepted())) return;
    const orgId=(await getActiveEntitlement()).org?.id;
    if(!orgId) return;
    const token=await getClerkToken();
    if(!token) return;
    const lease=await withDeadline(async signal=>{
      const response=await fetch(`${API_BASE}/v1/business/policy-stream/ticket`,{
        method:'POST',headers:{Authorization:`Bearer ${token}`},signal,cache:'no-store',redirect:'error',
      });
      if(!response.ok) throw new Error('Policy connection unavailable');
      return await response.json() as {orgId:string;ticket:string};
    });
    if(turn!==generation || lease.orgId!==orgId) return;
    const endpoint=new URL(`${API_BASE}/v1/business/policy-stream/${encodeURIComponent(orgId)}`);
    endpoint.protocol=endpoint.protocol==='https:' ? 'wss:' : 'ws:';
    const ws=new WebSocket(endpoint.toString(),`si-policy.${lease.ticket}`);
    socket=ws;
    let lastMessage=Date.now();
    const openDeadline=setTimeout(()=>{ if(ws.readyState!==WebSocket.OPEN) ws.close(); },10_000);
    ws.onopen=()=>{
      clearTimeout(openDeadline); failures=0;
      heartbeat=setInterval(()=>{
        if(Date.now()-lastMessage>45_000) { ws.close(); return; }
        if(ws.readyState===WebSocket.OPEN) ws.send('ping');
      },20_000);
    };
    ws.onmessage=event=>{
      lastMessage=Date.now();
      if(turn!==generation) return;
      try {
        const message=JSON.parse(event.data);
        if(message.type==='policy.changed') void reconcile().catch(()=>{});
        else if(message.type==='policy.version') void configItem.getValue().then(bundle=>{
          if(bundle?.policy?.orgId!==orgId || bundle.policyVersion!==message.version) return reconcile();
        }).catch(()=>{});
      } catch { ws.close(1008,'Invalid policy message'); }
    };
    ws.onclose=()=>{
      clearTimeout(openDeadline); clearInterval(heartbeat);
      if(socket===ws) socket=undefined;
      if(turn===generation) scheduleRetry();
    };
    ws.onerror=()=>ws.close();
  } catch {
    if(turn===generation) scheduleRetry();
  } finally { connecting=false; }
}

function scheduleRetry() {
  clearTimeout(retry);
  const delay=Math.min(30_000,1000*2**Math.min(failures++,5))+Math.random()*500;
  const turn=generation;
  retry=setTimeout(()=>{
    if(turn!==generation) return;
    // Refresh the signed entitlement as well as server-side membership on each lease.
    void refreshEntitlementBg().then(()=>ensurePolicyStream()).catch(()=>{ if(turn===generation) scheduleRetry(); });
  },delay);
}
