import { defineUnlistedScript } from '#imports';
import { createPasteComputation } from '@/lib/paste/process';
import type { PasteCommand, PasteOperations, PasteReply } from '@/lib/paste/protocol';

export default defineUnlistedScript(() => {
  const scope = globalThis as unknown as {
    onmessage: (
      event: MessageEvent<PasteCommand & { scan?: PasteOperations['scan']['input'] }>,
    ) => void;
    postMessage(reply: PasteReply): void;
  };
  scope.onmessage = async ({ data }) => {
    try {
      const compute = createPasteComputation();
      if (data.operation !== 'scan') {
        if (!data.scan) throw new Error('Missing scan context');
        // Rebuilds the text and findings synchronously; its digest is not needed here.
        void Promise.resolve(compute({ id: data.id, operation: 'scan', input: data.scan })).catch(
          () => {},
        );
      }
      scope.postMessage({ id: data.id, ok: true, result: await compute(data) });
    } catch {
      // Never include pasted text, matches, or exception details in IPC/logs.
      scope.postMessage({
        id: data.id,
        ok: false,
        error: 'Paste processing failed or exceeded its limits',
      });
    }
  };
});
