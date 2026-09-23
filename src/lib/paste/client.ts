import { browser } from '#imports';
import { abortable, withDeadline } from '../async';
import {
  type Operation,
  PASTE_PORT,
  PASTE_READY,
  PASTE_REQUEST_TIMEOUT_MS,
  type PasteOperations,
  type PasteProcessor,
  type PasteReply,
} from './protocol';

export async function createPasteProcessor(signal: AbortSignal): Promise<PasteProcessor> {
  signal.throwIfAborted();
  const ready = await abortable(
    withDeadline(() => browser.runtime.sendMessage({ type: PASTE_READY })),
    signal,
  );
  signal.throwIfAborted();
  if (ready?.ok !== true) throw new Error('Local paste processor is unavailable');
  const port = browser.runtime.connect({ name: PASTE_PORT });
  let closed = false;
  let sequence = 0;
  let pending:
    | { id: number; resolve: (value: unknown) => void; reject: (reason: Error) => void }
    | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    pending?.reject(new Error('Paste processor disconnected or was cancelled'));
    pending = undefined;
    signal.removeEventListener('abort', close);
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(close);
    port.disconnect();
  };
  const onMessage = (reply: PasteReply) => {
    if (closed || !pending || reply.id !== pending.id) return;
    const request = pending;
    pending = undefined;
    if (reply.ok) request.resolve(reply.result);
    else {
      request.reject(new Error(reply.error));
      close();
    }
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(close);
  signal.addEventListener('abort', close, { once: true });
  return {
    async request<K extends Operation>(
      operation: K,
      input: PasteOperations[K]['input'],
    ): Promise<PasteOperations[K]['output']> {
      signal.throwIfAborted();
      if (closed || pending) throw new Error('Paste processor is not ready');
      const id = ++sequence;
      try {
        // Backup deadline also covers a dead offscreen host or dropped IPC.
        return await abortable(
          withDeadline(
            () =>
              new Promise<PasteOperations[K]['output']>((resolve, reject) => {
                pending = {
                  id,
                  resolve: (value) => resolve(value as PasteOperations[K]['output']),
                  reject,
                };
                port.postMessage({ id, operation, input });
              }),
            new AbortController(),
            PASTE_REQUEST_TIMEOUT_MS,
          ),
          signal,
        );
      } catch (error) {
        close();
        throw error;
      }
    },
  };
}
