import { afterEach, describe, expect, test, vi } from 'vitest';
import { browser } from '#imports';
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
  test('passes the event to the background queue', () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);

    sendTelemetry(ev);

    expect(send).toHaveBeenCalledWith({ type: 'si-telemetry', event: ev });
  });

  test('swallows network errors (fire-and-forget)', () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('offline'));
    expect(() => sendTelemetry(ev)).not.toThrow();
  });
});
