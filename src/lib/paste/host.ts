import { browser } from '#imports';
import {
  IDLE_TIMEOUT_MS,
  MAX_PASTE_CHARS,
  MAX_PASTE_SESSIONS,
  MAX_PASTE_WORKERS,
  MAX_RETAINED_BYTES,
  PASTE_PORT,
  type PasteCommand,
  type PasteOperations,
  type PasteReply,
  QUEUE_TIMEOUT_MS,
  WORK_TIMEOUT_MS,
} from './protocol';

/** FIFO across tabs, bounded memory and CPU. Workers belong to operations,
 * not dialogs. Transformations re-scan the original input using its original
 * rules, so idle dialogs don't reserve threads or retain worker state. */
export function installPasteWorkerHost(
  makeWorker = () => new Worker(browser.runtime.getURL('/paste-worker.js')),
) {
  type Work = { start(): void };
  const queue: Work[] = [];
  let sessions = 0;
  let retainedBytes = 0;
  let running = 0;
  const idle: { worker: Worker; timer: ReturnType<typeof setTimeout> }[] = [];
  const pump = () => {
    while (running < MAX_PASTE_WORKERS && queue.length) queue.shift()?.start();
  };
  const acquire = () => {
    const slot = idle.pop();
    if (slot) {
      clearTimeout(slot.timer);
      return slot.worker;
    }
    return makeWorker();
  };
  const release = (worker: Worker) => {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    const slot = {
      worker,
      timer: setTimeout(() => {
        const index = idle.indexOf(slot);
        if (index !== -1) idle.splice(index, 1);
        worker.terminate();
      }, IDLE_TIMEOUT_MS),
    };
    idle.push(slot);
  };
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PASTE_PORT) return;
    if (
      port.sender?.id !== browser.runtime.id ||
      port.sender.tab?.id == null ||
      sessions >= MAX_PASTE_SESSIONS
    ) {
      port.disconnect();
      return;
    }
    sessions++;
    let scan: PasteOperations['scan']['input'] | undefined;
    let bytes = 0;
    let closed = false;
    let pending: number | undefined;
    let queued: Work | undefined;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (queued) {
        const index = queue.indexOf(queued);
        if (index !== -1) queue.splice(index, 1);
      }
      if (worker) {
        worker.terminate();
        worker = undefined;
        running--;
      }
      retainedBytes -= bytes;
      bytes = 0;
      scan = undefined;
      sessions--;
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(close);
      port.disconnect();
      pump();
    };
    const reply = (data: PasteReply) => {
      try {
        port.postMessage(data);
      } catch {
        close();
      }
    };
    const fail = (error: string) => {
      if (pending !== undefined) reply({ id: pending, ok: false, error });
      close();
    };
    const onMessage = (command: PasteCommand) => {
      if (closed) return;
      if (pending !== undefined || !Number.isSafeInteger(command?.id) || command.id < 1) {
        close();
        return;
      }
      pending = command.id;
      clearTimeout(timer);
      if (command.operation === 'scan') {
        if (
          scan ||
          typeof command.input?.text !== 'string' ||
          command.input.text.length > MAX_PASTE_CHARS ||
          !Array.isArray(command.input.patterns) ||
          command.input.patterns.length > 256
        ) {
          fail('Invalid or oversized scan');
          return;
        }
        // Conservative logical budget, including serialization/copy headroom.
        bytes = 4 * JSON.stringify(command.input).length;
        if (retainedBytes + bytes > MAX_RETAINED_BYTES) {
          bytes = 0;
          fail('Paste capacity reached; nothing was inserted. Try again shortly.');
          return;
        }
        scan = command.input;
        retainedBytes += bytes;
      } else if (!scan || !['sanitize', 'tokenize', 'rehydrate'].includes(command.operation)) {
        fail('Scan required before transformation');
        return;
      }
      if (
        command.operation === 'rehydrate' &&
        (!Array.isArray(command.input) ||
          command.input.length > 100_000 ||
          JSON.stringify(command.input).length > MAX_PASTE_CHARS * 2)
      ) {
        fail('Restoration data is too large');
        return;
      }
      if (command.operation === 'rehydrate') {
        const extra = 4 * JSON.stringify(command.input).length;
        if (retainedBytes + extra > MAX_RETAINED_BYTES) {
          fail('Paste capacity reached; nothing was inserted');
          return;
        }
        bytes += extra;
        retainedBytes += extra;
      }
      queued = {
        start() {
          queued = undefined;
          if (closed) return;
          try {
            worker = acquire();
          } catch {
            fail('Local processor unavailable');
            return;
          }
          running++;
          clearTimeout(timer);
          timer = setTimeout(
            () => fail('Paste processing timed out; nothing was inserted'),
            WORK_TIMEOUT_MS,
          );
          worker.onmessage = ({ data }: MessageEvent<PasteReply>) => {
            if (closed || data.id !== pending || !worker) return;
            clearTimeout(timer);
            const completed = worker;
            worker = undefined;
            running--;
            if (data.ok) release(completed);
            else completed.terminate();
            pending = undefined;
            reply(data);
            if (!data.ok) close();
            else if (!closed) timer = setTimeout(close, IDLE_TIMEOUT_MS);
            pump();
          };
          worker.onerror = (event) => {
            event.preventDefault();
            fail('Paste processor stopped unexpectedly');
          };
          worker.onmessageerror = () => fail('Paste processor returned an unreadable result');
          try {
            worker.postMessage({
              ...command,
              scan: command.operation === 'scan' ? undefined : scan,
            });
          } catch {
            fail('Paste processing could not start');
          }
        },
      };
      timer = setTimeout(
        () => fail('Paste queue is busy; nothing was inserted. Try again shortly.'),
        QUEUE_TIMEOUT_MS,
      );
      queue.push(queued);
      pump();
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(close);
    timer = setTimeout(close, IDLE_TIMEOUT_MS);
  });
}
