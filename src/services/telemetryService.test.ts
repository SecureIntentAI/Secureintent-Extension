import { afterEach, describe, expect, test, vi } from 'vitest';
import { API_BASE } from '@/lib/api/client';
import type { Fingerprint } from '@/lib/fingerprint';
import { buildEvent, sendTelemetry } from './telemetryService';

afterEach(() => vi.restoreAllMocks());

describe('buildEvent', () => {
  test('assembles an event with a unique id and the given fields', () => {
    const ev = buildEvent({
      site: 'Claude',
      policyVersion: 0,
      detections: [
        { fingerprint: 'a'.repeat(64) as Fingerprint, type: 'known-key', label: 'OpenAI API key' },
      ],
      action: 'paste_anonymously',
      plan: 'developer',
      source: 'none',
      signedIn: false,
      businessDomain: null,
    });
    expect(ev.site).toBe('Claude');
    expect(ev.action).toBe('paste_anonymously');
    expect(ev.detections).toHaveLength(1);
    expect(ev.eventId).toMatch(/[0-9a-f-]{36}/);
  });

  test('never carries raw secret text — only fingerprints', () => {
    const ev = buildEvent({
      site: 'Claude',
      policyVersion: 0,
      detections: [
        {
          fingerprint: 'b'.repeat(64) as Fingerprint,
          type: 'private-key',
          label: 'RSA private key',
        },
      ],
      action: 'cancelled',
      plan: 'business_pro',
      source: 'business_email',
      signedIn: true,
      businessDomain: 'acme.com',
    });
    expect(JSON.stringify(ev)).not.toMatch(/BEGIN|sk-|AKIA/);
  });
});

const ev = {
  eventId: 'e1',
  site: 'ChatGPT',
  policyVersion: 0,
  browser: 'chrome',
  detections: [
    {
      fingerprint: 'a'.repeat(64) as Fingerprint,
      type: 'known-key' as const,
      label: 'OpenAI API key',
    },
  ],
  action: 'paste_anonymously' as const,
  plan: 'developer',
  source: 'none',
  signedIn: false,
  businessDomain: null,
};

describe('sendTelemetry', () => {
  test('POSTs the event JSON to /v1/telemetry', () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('', { status: 202 })));
    vi.stubGlobal('fetch', fetchMock);

    sendTelemetry(ev);

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe(`${API_BASE}/v1/telemetry`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({...ev,site:location.hostname});
  });

  test('swallows network errors (fire-and-forget)', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    expect(() => sendTelemetry(ev)).not.toThrow();
  });
});
