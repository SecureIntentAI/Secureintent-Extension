import { describe, expect, test } from 'vitest';
import { DEFAULT_BUNDLE } from './default';
import { shouldAcceptBundle } from './freshness';
import type { BundlePolicy, ConfigBundle } from './types';

const policy = (orgId: string): BundlePolicy => ({
  orgId,
  blockInsteadOfWarn: false,
  requireSessionLock: false,
  blockedSites: [],
});

function bundle(over: Partial<ConfigBundle> = {}): ConfigBundle {
  return { ...DEFAULT_BUNDLE, version: 12, ...over };
}

describe('shouldAcceptBundle', () => {
  test('stores the first bundle', () => {
    expect(shouldAcceptBundle(null, bundle(), false)).toBe(true);
  });

  test('an anonymous catalogue upgrade cannot remove team rules', () => {
    const current = bundle({ policy: policy('org_a'), policyVersion: 3 });
    expect(shouldAcceptBundle(current, bundle({ version: 13 }), false)).toBe(false);
    expect(shouldAcceptBundle(current, bundle({ version: 13 }), true)).toBe(true);
  });
  test('an organisation switch accepts the new organisation lower revision', () => {
    expect(
      shouldAcceptBundle(
        bundle({ policy: policy('org_a'), policyVersion: 100 }),
        bundle({ policy: policy('org_b'), policyVersion: 1 }),
        true,
      ),
    ).toBe(true);
  });

  test('an older catalogue is ignored', () => {
    expect(shouldAcceptBundle(bundle({ version: 13 }), bundle({ version: 12 }), true)).toBe(false);
  });

  test('a signed-in member picks up a policy published at the same catalogue version', () => {
    const current = bundle();
    const incoming = bundle({ policy: policy('org_a'), policyVersion: 1 });
    expect(shouldAcceptBundle(current, incoming, true)).toBe(true);
  });

  test('a later policy revision replaces the one stored', () => {
    const current = bundle({ policy: policy('org_a'), policyVersion: 1 });
    const incoming = bundle({
      policy: { ...policy('org_a'), blockedSites: ['pastebin.com'] },
      policyVersion: 2,
    });
    expect(shouldAcceptBundle(current, incoming, true)).toBe(true);
  });

  test('an older policy revision cannot roll the rules back', () => {
    const current = bundle({ policy: policy('org_a'), policyVersion: 4 });
    const incoming = bundle({ policy: policy('org_a'), policyVersion: 2 });
    expect(shouldAcceptBundle(current, incoming, true)).toBe(false);
  });

  test('switching organisation at the same revision replaces the rules', () => {
    const current = bundle({ policy: policy('org_a'), policyVersion: 1 });
    const incoming = bundle({ policy: policy('org_b'), policyVersion: 1 });
    expect(shouldAcceptBundle(current, incoming, true)).toBe(true);
  });

  test('a signed-in response with no policy drops rules after the member leaves', () => {
    const current = bundle({ policy: policy('org_a'), policyVersion: 4 });
    expect(shouldAcceptBundle(current, bundle(), true)).toBe(true);
  });

  test('an anonymous refresh neither installs nor removes team rules', () => {
    const withPolicy = bundle({ policy: policy('org_a'), policyVersion: 4 });
    const plain = bundle();
    expect(shouldAcceptBundle(plain, withPolicy, false)).toBe(false);
    expect(shouldAcceptBundle(withPolicy, plain, false)).toBe(false);
  });

  test('the same signed-in bundle is not written again', () => {
    const current = bundle({ policy: policy('org_a'), policyVersion: 4 });
    expect(shouldAcceptBundle(current, { ...current }, true)).toBe(false);
  });
});
