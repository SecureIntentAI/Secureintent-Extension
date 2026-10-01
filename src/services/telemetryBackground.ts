import { API_BASE } from '@/lib/api/client';
import { withDeadline } from '@/lib/async';
import { isConsentAccepted } from '@/lib/consent';
import { getClerkToken } from './entitlementBackground';

/** Credentials stay in the background; destination comes from the browser sender. */
export async function sendAuthenticatedTelemetry(message: unknown, senderUrl?: string) {
  if (!(await isConsentAccepted())) return null;
  const event = (message as {event?:Record<string,unknown>})?.event;
  if (!event || typeof event !== 'object') return null;
  let hostname: string;
  try { hostname = new URL(senderUrl ?? '').hostname; } catch { return null; }
  const token = await getClerkToken();
  if (!token) return null;
  return withDeadline(async signal => {
    const response = await fetch(`${API_BASE}/v1/telemetry`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({...event,site:hostname}),cache:'no-store',redirect:'error',signal,
    });
    return response.ok ? {accepted:true} : null;
  });
}
