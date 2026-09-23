import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE } from '@/lib/api/client';
import { sendShadowEvents } from './api';
import type { VisitEvent } from './visits';

const event: VisitEvent = {
  schemaVersion: 1,
  eventId: '88267dc6-3915-4a2d-957f-848f211fce45',
  type: 'ai_page_visit',
  timestamp: 1,
  hostname: 'chatgpt.com',
  serviceId: 'chatgpt',
  catalogVersion: 1,
};

afterEach(() => vi.unstubAllGlobals());

describe('sendShadowEvents', () => {
  it('posts metadata to the production API with the Clerk session', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ acceptedIds: [event.eventId] }), { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendShadowEvents('clerk-jwt', [event])).resolves.toEqual([event.eventId]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/v1/shadow/events`);
    expect(url).not.toContain('127.0.0.1');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer clerk-jwt' });
    expect(String(init.body)).not.toMatch(/paste|prompt|secret/i);
  });
});
