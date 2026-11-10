const PREFIX = '[SecureIntent]';

/**
 * Diagnostic logging is for development builds only. Vite replaces
 * `import.meta.env.DEV` with a constant at build time, so in a production build
 * `siDebug` is an empty function and the bundler drops the calls with it.
 */
// console.info (not console.debug, which Chrome hides under "Verbose"); never log raw secrets
export function siDebug(site: string, event: string, data?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  if (data === undefined) {
    console.info(`${PREFIX} ${site} · ${event}`);
  } else {
    console.info(`${PREFIX} ${site} · ${event}`, data);
  }
}

export function siError(site: string, event: string, err: unknown): void {
  console.error(`${PREFIX} ${site} · ${event}`, err);
}

export function elapsedMs(since: number): number {
  return Math.round((performance.now() - since) * 10) / 10;
}
