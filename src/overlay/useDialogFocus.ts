import { useLayoutEffect, useRef } from 'react';

/** Keep keyboard focus inside paste dialogs, including closed shadow roots. */
export function useDialogFocus() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const previous = document.activeElement;
    const root = container.getRootNode();
    const activeElement = () =>
      root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    const focusable = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
        ),
      );
    const first = container.querySelector<HTMLElement>('.si-btn-ghost') ?? focusable()[0];
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      const index = items.indexOf(activeElement() as HTMLElement);
      const next = (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    };
    container.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('keydown', onKey);
      // An insertion has already focused the editor and positioned its caret.
      // Restore only when focus is still in the dialog (e.g. Cancel/Escape).
      if (
        container.contains(activeElement()) &&
        previous instanceof HTMLElement &&
        previous.isConnected
      ) {
        previous.focus();
      }
    };
  }, []);
  return ref;
}
