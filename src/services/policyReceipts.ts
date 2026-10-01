import { browser } from '#imports';

/** A fresh challenge measures running page guards; never treats a storage write as enforcement. */
export async function collectPolicyReceipts(orgId:string, version:number) {
  const tabs = (await browser.tabs.query({})).filter(t=>!t.incognito && t.id !== undefined && /^https?:/.test(t.url ?? ''));
  const expected = new Set(tabs.map(t=>t.id!));
  const nonce = crypto.randomUUID();
  const confirmed = new Set<number>();
  let disabled = false;
  let stale = false;
  let guards = 0;
  const seen = new Set<string>();
  const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (raw,sender) => {
    const m = raw as {type?:string;nonce?:string;orgId?:string;version?:number;active?:boolean};
    if (m?.type !== 'si-policy-receipt' || m.nonce!==nonce || sender.tab?.id===undefined || !expected.has(sender.tab.id)) return false;
    const key = `${sender.tab.id}:${sender.frameId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!m.active) disabled=true;
    else if (m.orgId!==orgId || m.version!==version) stale=true;
    else { guards++; if ((sender.frameId ?? 0)===0) confirmed.add(sender.tab.id); }
    return false;
  };
  browser.runtime.onMessage.addListener(listener);
  try {
    for (const tab of tabs) void browser.tabs.sendMessage(tab.id!,{type:'si-policy-probe',nonce}).catch(()=>{});
    await new Promise(resolve=>setTimeout(resolve,400));
    return {
      policyState:disabled ? 'disabled' : stale ? 'pending' : !tabs.length ? 'downloaded' : confirmed.size===expected.size ? 'guards_confirmed' : 'pending',
      confirmedGuards:guards, expectedPages:tabs.length,
    };
  } finally { browser.runtime.onMessage.removeListener(listener); }
}
