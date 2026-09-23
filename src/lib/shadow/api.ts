import { API_BASE } from '@/lib/api/client';
import type { ShadowEvent } from './visits';

export class ShadowApiError extends Error {
  constructor(public status: number) {
    super('Shadow report failed');
  }
}

/**
 * Upload a batch of Shadow AI metadata to the production API.
 * The Clerk session is the only credential. The body is the event list; the
 * Worker derives the organisation from that session and rejects anything else.
 */
export async function sendShadowEvents(token: string, events: ShadowEvent[]): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${API_BASE}/v1/shadow/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ events }),
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new ShadowApiError(response.status);
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== 'object' ||
      !Array.isArray((value as { acceptedIds?: unknown }).acceptedIds)
    ) {
      throw new Error('Invalid acknowledgement');
    }
    const accepted = (value as { acceptedIds: unknown[] }).acceptedIds.filter(
      (id): id is string => typeof id === 'string' && events.some((event) => event.eventId === id),
    );
    return accepted;
  } finally {
    clearTimeout(timer);
  }
}
