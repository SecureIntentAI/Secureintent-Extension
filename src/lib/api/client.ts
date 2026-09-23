// Production by default. Override at build time to point a local build at a
// `wrangler dev` Worker, so testing never writes into the live database:
//   WXT_API_BASE=http://localhost:8787 pnpm build
export const API_BASE = import.meta.env.WXT_API_BASE ?? 'https://api.secureintent.ai';

export async function getJson<T>(path: string, headers?: Record<string, string>): Promise<T> {
  // no-store: config must never come from the HTTP cache (always latest bundle)
  return withDeadline(async (signal) => {
    const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', headers, signal });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  });
}

// Fire-and-forget POST: never throws, survives navigation.
export function postJson(path: string, body: unknown): void {
  fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

import { withDeadline } from '@/lib/async';
