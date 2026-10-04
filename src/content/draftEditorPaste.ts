const DRAFT_EDITOR = '.public-DraftEditor-content[contenteditable="true"]';

export function isDraftEditor(el: HTMLElement): boolean {
  return el.matches(DRAFT_EDITOR);
}

function blocks(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('[data-block="true"]')).filter(
    (block) => block.closest(DRAFT_EDITOR) === el,
  );
}

function plainText(el: HTMLElement): string {
  // Range.toString() omits the boundaries between Draft's content blocks.
  // Empty blocks matter too: they represent blank and trailing lines.
  return blocks(el).map(blockText).join('\n');
}

function blockText(block: HTMLElement): string {
  const text = block.textContent ?? '';
  // DraftEditorLeaf adds a DOM-only newline when its final leaf ends in a
  // soft newline (Shift+Enter), so the browser can draw the trailing caret.
  return text.endsWith('\n\n') ? text.slice(0, -1) : text;
}

function selectionOffsets(el: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (!anchorNode || !focusNode || !el.contains(anchorNode) || !el.contains(focusNode)) {
    return null;
  }
  const offsetOf = (node: Node, offset: number): number => {
    let length = 0;
    for (const block of blocks(el)) {
      const range = document.createRange();
      range.selectNodeContents(block);
      const position = range.comparePoint(node, offset);
      if (position < 0) return length;
      if (position === 0) {
        range.setEnd(node, offset);
        return length + Math.min(range.toString().length, blockText(block).length);
      }
      length += blockText(block).length + 1;
    }
    return Math.max(0, length - 1);
  };
  const anchor = offsetOf(anchorNode, anchorOffset);
  const focus = offsetOf(focusNode, focusOffset);
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

const nextTask = (delay = 0) => new Promise<void>((resolve) => setTimeout(resolve, delay));

/** Replay only the checked plain text through Draft's controlled editor model. */
export async function pasteIntoDraft(
  el: HTMLElement,
  text: string,
  isCurrent: () => boolean,
  applyInsertion: (action: () => boolean) => boolean = (action) => action(),
): Promise<void> {
  const before = plainText(el);
  const selection = selectionOffsets(el);
  if (!selection || !blocks(el).length) {
    throw new Error('The editor selection could not be checked');
  }
  // Draft normalizes clipboard line endings when constructing content blocks.
  const expected =
    before.slice(0, selection.start) + text.replace(/\r\n?/g, '\n') + before.slice(selection.end);

  // Restoring the saved DOM Range schedules selectionchange. Let Draft update
  // its own SelectionState before its paste handler reads that state.
  await nextTask();
  if (!isCurrent() || !el.isConnected) throw new Error('The pending paste was cancelled');
  const current = selectionOffsets(el);
  if (
    plainText(el) !== before ||
    current?.start !== selection.start ||
    current.end !== selection.end
  ) {
    throw new Error('The saved paste position is no longer available');
  }

  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);
  const handled = !applyInsertion(() =>
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  // A synthetic paste has no browser default insertion. Never fall back to
  // execCommand here: it can create visible DOM that Draft will not save.
  if (!handled) throw new Error('The editor refused the checked paste');

  // A controlled editor may commit after the event handler returns. Cancellation
  // alone does not prove acceptance (custom paste handlers can reject text).
  const deadline = performance.now() + 250;
  while (plainText(el) !== expected) {
    if (!isCurrent() || !el.isConnected) throw new Error('The pending paste was cancelled');
    if (performance.now() >= deadline)
      throw new Error('The editor did not accept the checked text');
    await nextTask(16);
  }
  if (!isCurrent() || !el.isConnected) throw new Error('The pending paste was cancelled');
}
