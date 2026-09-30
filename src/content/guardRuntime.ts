import {
  type ConfigBundle,
  DEFAULT_BUNDLE,
  getPolicy,
  isBlockedHost,
  validateBundle,
} from '@/lib/config';
import { compilePatterns, GHOST_EXTRA_PATTERNS, GHOST_MIN_CHARS } from '@/lib/detection';
import type { SiteConfig } from './types';

/** All configuration needed synchronously at a paste/insertion boundary. */
export function createGuardRuntime(bundle: ConfigBundle, config: SiteConfig, host: string) {
  if (!validateBundle(bundle)) throw new Error('Invalid guard bundle');
  const compiled = compilePatterns(bundle.patterns);
  if (
    compiled.length !== bundle.patterns.length ||
    compiled.some((pattern) => !pattern.regex.global)
  ) {
    throw new Error('Guard patterns must compile and support global iteration');
  }
  const policy = getPolicy(bundle);
  const policyBlockedHost = isBlockedHost(host, policy.blockedSites);
  const inputSelector =
    bundle.sites[config.siteKey]?.inputSelector ??
    DEFAULT_BUNDLE.sites[config.siteKey]?.inputSelector;
  // Syntax-check without depending on whether the editor exists at document_start.
  if (inputSelector !== undefined) document.createDocumentFragment().querySelector(inputSelector);
  const ghostMin = bundle.ghost?.minChars ?? GHOST_MIN_CHARS;
  if (!Number.isFinite(ghostMin) || ghostMin <= 0) throw new Error('Invalid Ghost threshold');
  return {
    bundle,
    policy,
    policyBlockedHost,
    allowRawPaste: !policy.blockInsteadOfWarn && !policyBlockedHost,
    patterns:
      bundle.aggressive === false ? compiled.filter((p) => p.validate !== 'entropy') : compiled,
    ghostPatterns: [...compiled.filter((p) => p.validate !== 'entropy'), ...GHOST_EXTRA_PATTERNS],
    ghostMin,
    inputSelector,
  };
}
