/** Await even a non-cancellable API without keeping callers stuck after abort. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Give input, rendering and cancellation a turn between CPU work batches. */
export function yieldToBrowser(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
}

export const REQUEST_TIMEOUT_MS = 10_000;

export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  controller = new AbortController(),
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await abortable(work(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
