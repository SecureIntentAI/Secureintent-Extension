import { API_BASE } from '@/lib/api/client';
import { abortable, withDeadline } from '@/lib/async';
import { configItem } from '@/lib/config/store';
import { isConsentAccepted } from '@/lib/consent';
import { getActiveEntitlement } from '@/lib/entitlement';
import { reportBusinessConnection } from './businessConnection';
import { syncConfig } from './configService';
import { getClerkToken, refreshEntitlementBg } from './entitlementBackground';

let socket: WebSocket | undefined;
let connecting: AbortController | undefined;
let generation = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let cleanupSocket: (() => void) | undefined;
let failures = 0;
let syncing = false;
let dirty = false;

// Coalesce bursts but reconcile again when a save arrives during an in-flight fetch.
async function reconcile(turn: number) {
  if (turn !== generation) return;
  dirty = true;
  if (syncing) return;
  syncing = true;
  try {
    do {
      dirty = false;
      const activeGeneration = generation;
      await syncConfig();
      if (activeGeneration !== generation) continue;
      await reportBusinessConnection();
    } while (dirty);
  } finally {
    syncing = false;
  }
}

export function stopPolicyStream() {
  generation++;
  connecting?.abort();
  connecting = undefined;
  dirty = false;
  failures = 0;
  clearTimeout(retry);
  retry = undefined;
  cleanupSocket?.();
  cleanupSocket = undefined;
  const old = socket;
  socket = undefined;
  if (old) {
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    old.close();
  }
}

/** Reconnect also runs from the persisted minute alarm if MV3 suspended the worker. */
export async function ensurePolicyStream(): Promise<void> {
  if (connecting || socket) return;
  const attempt = new AbortController();
  connecting = attempt;
  clearTimeout(retry);
  retry = undefined;
  const turn = generation;
  try {
    const lease = await withDeadline(async (signal) => {
      if (!(await abortable(isConsentAccepted(), signal))) return null;
      const orgId = (await abortable(getActiveEntitlement(), signal)).org?.id;
      if (!orgId) return null;
      const token = await abortable(getClerkToken(), signal);
      if (!token) return null;
      const response = await fetch(`${API_BASE}/v1/business/policy-stream/ticket`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal,
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Policy connection unavailable');
      const result = (await response.json()) as { orgId?: unknown; ticket?: unknown };
      if (result.orgId !== orgId || typeof result.ticket !== 'string' || !result.ticket)
        throw new Error('Policy connection organization mismatch');
      signal.throwIfAborted();
      return { orgId, ticket: result.ticket };
    }, attempt);
    if (turn !== generation || !lease) return;
    const { orgId } = lease;
    const endpoint = new URL(`${API_BASE}/v1/business/policy-stream/${encodeURIComponent(orgId)}`);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(endpoint.toString(), `si-policy.${lease.ticket}`);
    socket = ws;
    let lastMessage = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const openDeadline = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) ws.close();
    }, 10_000);
    const cleanup = () => {
      clearTimeout(openDeadline);
      clearInterval(heartbeat);
    };
    cleanupSocket = cleanup;
    ws.onopen = () => {
      if (turn !== generation || socket !== ws) {
        ws.close();
        return;
      }
      clearTimeout(openDeadline);
      failures = 0;
      heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 45_000) {
          ws.close();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, 20_000);
    };
    ws.onmessage = (event) => {
      lastMessage = Date.now();
      if (turn !== generation) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'policy.changed') void reconcile(turn).catch(() => {});
        else if (message.type === 'policy.version')
          void configItem
            .getValue()
            .then((bundle) => {
              if (bundle?.policy?.orgId !== orgId || bundle.policyVersion !== message.version)
                return reconcile(turn);
            })
            .catch(() => {});
      } catch {
        ws.close(1008, 'Invalid policy message');
      }
    };
    ws.onclose = () => {
      cleanup();
      if (socket === ws) {
        socket = undefined;
        cleanupSocket = undefined;
      }
      if (turn === generation) scheduleRetry();
    };
    ws.onerror = () => ws.close();
  } catch {
    if (turn === generation) scheduleRetry();
  } finally {
    if (connecting === attempt) connecting = undefined;
  }
}

function scheduleRetry() {
  clearTimeout(retry);
  const ceiling = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
  const delay = ceiling * (0.5 + Math.random() * 0.5);
  const turn = generation;
  retry = setTimeout(() => {
    if (turn !== generation) return;
    // Refresh the signed entitlement as well as server-side membership on each lease.
    retry = undefined;
    void refreshEntitlementBg()
      .then(() => {
        if (turn === generation) return ensurePolicyStream();
      })
      .catch(() => {
        if (turn === generation) scheduleRetry();
      });
  }, delay);
}
