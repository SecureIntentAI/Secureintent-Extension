/** Preserve the user's insertion point before focus moves into an extension UI. */
export function capturePasteSelection(input: HTMLElement): (() => void) | undefined {
  if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const direction = input.selectionDirection;
    if (start === null || end === null) return undefined;
    return () => input.setSelectionRange(start, end, direction ?? undefined);
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount || !input.contains(selection.anchorNode)) return undefined;
  const range = selection.getRangeAt(0).cloneRange();
  return () => {
    if (!input.contains(range.commonAncestorContainer)) return;
    selection.removeAllRanges();
    selection.addRange(range);
  };
}
