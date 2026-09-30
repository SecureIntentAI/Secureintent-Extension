import { browser } from '#imports';
import { consentItem, consentSatisfied, isConsentAccepted } from '@/lib/consent';
import { AI_CATALOG } from '@/lib/shadow/catalog';
import { DEMO_STATE_KEY, demoPolicyItem, SHADOW_DEMO } from '@/lib/shadow/demoConfig';
import type { AiServiceRule } from '@/lib/config/types';
import type { ShadowEvent } from '@/lib/shadow/visits';
import { parseShadowMessage } from './shadowBackground';

const MAX_EVENTS = 5000;
const RETENTION = 90 * 86400000;
type State = { enabled: boolean; events: ShadowEvent[]; revision: number; dropped: number };
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work);
  tail = result.catch(() => undefined);
  return result;
}
async function read(): Promise<State> {
  const data = (await browser.storage.local.get(DEMO_STATE_KEY))[DEMO_STATE_KEY] as State | undefined;
  return data || { enabled: false, events: [], revision: 0, dropped: 0 };
}
function save(state: State) { return browser.storage.local.set({ [DEMO_STATE_KEY]: state }); }

/** Demo observations never enter the signed-in organisation's upload queue. */
export function recordDemoShadow(message: unknown, sender: { url?: string; frameId?: number; incognito?: boolean }) {
  return serial(async () => {
    if (!SHADOW_DEMO || !(await isConsentAccepted())) return;
    const state = await read();
    if (!state.enabled) return;
    const event = parseShadowMessage(sender, message, Date.now());
    if (!event || state.events.some(item => item.eventId === event.eventId)) return;
    const retained = state.events.filter(item => item.timestamp >= Date.now() - RETENTION);
    const overflow = Math.max(0, retained.length + 1 - MAX_EVENTS);
    await save({ ...state, events: [...retained.slice(overflow), event], revision: state.revision + 1, dropped: state.dropped + overflow });
  });
}

function snapshot(state: State, rules: AiServiceRule[], days: number, offset: number) {
  const now = Date.now();
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  const since = start.getTime() - (days - 1) * 86400000;
  const events = state.events.filter(event => event.timestamp >= since);
  const tools = [...new Set(events.map(event => event.serviceId))].map(id => {
    const service = AI_CATALOG.services.find(item => item.id === id)!;
    const own = events.filter(event => event.serviceId === id);
    const rule = rules.find(item => item.serviceId === id);
    return { serviceId: id, name: service?.name || id, hostname: service?.hostnames[0] || own[0].hostname,
      observedHostnames: [...new Set(own.map(event => event.hostname))], classification: rule?.classification || 'recognized',
      pasteMode: rule?.pasteMode || 'normal', pasteBlocked: rule?.pasteMode === 'block_all',
      visits: own.filter(event => event.type === 'ai_page_visit').length,
      pastes: own.filter(event => event.type === 'ai_paste_volume').length,
      bytes: own.reduce((sum, event) => sum + (event.type === 'ai_paste_volume' ? event.byteSize : 0), 0),
      sensitiveEvents: own.filter(event => event.type === 'ai_sensitive_paste').length,
      activeSeats: null, lastSeen: Math.max(...own.map(event => event.timestamp)) };
  }).sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name));
  const sum = (key: 'visits' | 'pastes' | 'bytes' | 'sensitiveEvents') => tools.reduce((n, tool) => n + tool[key], 0);
  const visits = sum('visits');
  const trends = Array.from({ length: days }, (_, i) => ({ day: new Date(since + i * 86400000).toISOString().slice(0, 10), visits: 0, pastes: 0, sensitiveEvents: 0 }));
  const byDay = new Map(trends.map(row => [row.day, row]));
  for (const event of events) {
    const row = byDay.get(new Date(event.timestamp).toISOString().slice(0, 10));
    if (row) row[event.type === 'ai_page_visit' ? 'visits' : event.type === 'ai_paste_volume' ? 'pastes' : 'sensitiveEvents']++;
  }
  const dlp = events.filter(event => event.type === 'ai_sensitive_paste').sort((a, b) => b.timestamp - a.timestamp || b.eventId.localeCompare(a.eventId));
  return {
    dashboard: { generatedAt: now, dataAsOf: events.length ? Math.max(...events.map(event => event.timestamp)) : null,
      canManagePolicy: true, policyVersion: state.revision, demoEnabled: state.enabled, droppedEvents: state.dropped,
      summary: { totalTools: tools.length, totalVisits: visits, pasteAttempts: sum('pastes'), pasteBytes: sum('bytes'), sensitiveEvents: sum('sensitiveEvents'),
        highRiskDestinations: tools.filter(tool => tool.classification === 'review').length,
        unsanctionedUsagePercent: visits ? tools.filter(tool => tool.classification !== 'sanctioned').reduce((n, tool) => n + tool.visits, 0) / visits * 100 : 0 }, tools, trends },
    ledger: { events: dlp.slice(offset, offset + 25), total: dlp.length, nextOffset: offset + 25 < dlp.length ? offset + 25 : null },
    recent: { events: dlp.slice(0, 4) },
  };
}

/** Only the packaged extension dashboard can read data or change local policy. */
export function installShadowDemo() {
  if (!SHADOW_DEMO) return;
  const pauseWithoutConsent = () => serial(async () => {
    if (await isConsentAccepted()) return;
    const state = await read();
    if (state.enabled) await save({ ...state, enabled: false, revision: state.revision + 1 });
  });
  void pauseWithoutConsent().catch(() => {});
  consentItem.watch(value => {
    if (!consentSatisfied(value)) void pauseWithoutConsent().catch(() => {});
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'si-shadow-demo') return false;
    if (sender.id !== browser.runtime.id || sender.url?.split(/[?#]/, 1)[0] !== new URL('shadow.html', browser.runtime.getURL('/popup.html')).href) return false;
    void serial(async () => {
      const state = await read();
      if (message.action === 'snapshot') {
        const days = [7, 30, 90].includes(message.days) ? message.days : 30;
        const offset = Number.isSafeInteger(message.offset) && message.offset >= 0 ? message.offset : 0;
        return snapshot(state, await demoPolicyItem.getValue(), days, offset);
      }
      if (message.action === 'enable' && typeof message.enabled === 'boolean') {
        if (message.enabled && !(await isConsentAccepted())) throw new Error('Accept the extension Terms and Privacy notice first.');
        await save({ ...state, enabled: message.enabled, revision: state.revision + 1 });
        return { ok: true };
      }
      if (message.action === 'clear') {
        await save({ ...state, events: [], dropped: 0, revision: state.revision + 1 });
        return { ok: true };
      }
      if (message.action === 'policy') {
        if (!AI_CATALOG.services.some(service => service.id === message.serviceId) ||
          !['sanctioned', 'recognized', 'review'].includes(message.classification) ||
          !['normal', 'block_sensitive', 'block_all'].includes(message.pasteMode)) throw new Error('Invalid demo policy.');
        const rules = await demoPolicyItem.getValue();
        await demoPolicyItem.setValue([...rules.filter(rule => rule.serviceId !== message.serviceId), {
          serviceId: message.serviceId, classification: message.classification, pasteMode: message.pasteMode,
        }]);
        await save({ ...state, revision: state.revision + 1 });
        return { ok: true, policyVersion: state.revision + 1, policyRefreshAfterSeconds: 0 };
      }
      throw new Error('Unknown demo action.');
    }).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Demo operation failed.' }));
    return true;
  });
}
