import { describe, expect, it } from 'vitest';
import { emptyVisitState } from '@/lib/shadow/visits';
import { reduceShadowMessage } from './shadowBackground';

const now = 1_790_000_000_000;
const sender = { url: 'https://chatgpt.com/c/PRIVATE?prompt=SECRET', frameId: 0 };
const business = { plan: 'business_pro', orgId: 'org_acme' };
const visit = { type: 'si-shadow-visit', eventId: '88267dc6-3915-4a2d-957f-848f211fce45' };

describe('reduceShadowMessage', () => {
  it('queues a hostname-only visit for a consented Business seat', () => {
    const next = reduceShadowMessage(emptyVisitState(), business, true, sender, visit, now);
    expect(next.queue).toHaveLength(1);
    expect(JSON.stringify(next.queue[0])).not.toMatch(/PRIVATE|SECRET|prompt/);
    expect(next.queue[0]).toMatchObject({ hostname: 'chatgpt.com', serviceId: 'chatgpt' });
  });

  it('records nothing for Free or Developer Pro', () => {
    for (const seat of [
      { plan: 'developer', orgId: null },
      { plan: 'developer_pro', orgId: null },
      { plan: 'business_pro', orgId: null },
    ]) {
      expect(reduceShadowMessage(emptyVisitState(), seat, true, sender, visit, now).queue).toEqual(
        [],
      );
    }
  });

  it('holds the event until Terms are accepted', () => {
    expect(
      reduceShadowMessage(emptyVisitState(), business, false, sender, visit, now).queue,
    ).toEqual([]);
  });

  it('drops a queued batch when the seat is no longer Business', () => {
    const queued = reduceShadowMessage(emptyVisitState(), business, true, sender, visit, now);
    const cleared = reduceShadowMessage(
      queued,
      { plan: 'developer', orgId: null },
      true,
      sender,
      visit,
      now,
    );
    expect(cleared.queue).toEqual([]);
    expect(cleared.dropped).toBe(1);
  });
});
