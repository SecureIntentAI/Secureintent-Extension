import { type ConfigBundle, DEFAULT_BUNDLE, getPolicy, isBlockedHost } from '@/lib/config';
import { compilePatterns, GHOST_EXTRA_PATTERNS, GHOST_MIN_CHARS } from '@/lib/detection';
import type { SiteConfig } from './types';

/** All configuration needed synchronously at a paste/insertion boundary. */
export function createGuardRuntime(bundle: ConfigBundle, config: SiteConfig, host: string) {
  const compiled = compilePatterns(bundle.patterns);
  const policy = getPolicy(bundle);
  const policyBlockedHost = isBlockedHost(host, policy.blockedSites);
  return {
    bundle,
    policy,
    policyBlockedHost,
    allowRawPaste: !policy.blockInsteadOfWarn && !policyBlockedHost,
    patterns:
      bundle.aggressive === false ? compiled.filter((p) => p.validate !== 'entropy') : compiled,
    ghostPatterns: [...compiled.filter((p) => p.validate !== 'entropy'), ...GHOST_EXTRA_PATTERNS],
    ghostMin: typeof bundle.ghost?.minChars === 'number' ? bundle.ghost.minChars : GHOST_MIN_CHARS,
    inputSelector:
      bundle.sites[config.siteKey]?.inputSelector ??
      DEFAULT_BUNDLE.sites[config.siteKey]?.inputSelector,
  };
}
