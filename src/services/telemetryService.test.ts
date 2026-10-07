import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import type { Fingerprint } from '@/lib/fingerprint';
import { buildEvent, sendTelemetry } from './telemetryService';

const input = {
  site: 'Claude',
  policyVersion: 0,
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
beforeEach(() => fakeBrowser.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildEvent', () => {
  test('keeps stable event ID and private origin owner across delayed dispatch', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const owner = { userId: 'user_original', orgId: 'org_original' };
    const event = buildEvent({ ...input, signedIn: true, orgId: owner.orgId }, owner);
    owner.userId = 'user_next';
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.site).toBe('Claude');
    expect(JSON.stringify(event)).not.toContain('user_original');
    sendTelemetry(event);
    expect(send).toHaveBeenCalledWith({
      type: 'si-telemetry',
      event,
      owner: { userId: 'user_original', orgId: 'org_original' },
    });
  });
});

describe('sendTelemetry', () => {
  test('sends anonymous metadata to the background for consent checks and persistence', () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const event = buildEvent(input);
    sendTelemetry(event);
    expect(send).toHaveBeenCalledWith({ type: 'si-telemetry', event, owner: null });
    expect(fetch).not.toHaveBeenCalled();
  });
  test('drops signed-in events without their original owner', () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    sendTelemetry(buildEvent({ ...input, signedIn: true }));
    expect(send).not.toHaveBeenCalled();
  });
  test('contains message transport failures', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('Extension reloaded'));
    expect(() => sendTelemetry(buildEvent(input))).not.toThrow();
    await Promise.resolve();
  });
});
