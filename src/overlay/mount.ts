import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { type ContentScriptContext, createShadowRootUi } from '#imports';
import { Overlay, type OverlayAction, type OverlayProps } from './Overlay';

export interface OverlayHandle {
  remove(): void;
}

// Closed Shadow DOM isolates internals/styles; its host is still part of the page.
export async function mountOverlay(
  ctx: ContentScriptContext,
  props: Omit<OverlayProps, 'onAction'> & { onAction: (action: OverlayAction) => void },
): Promise<OverlayHandle> {
  const ui = await createShadowRootUi<Root>(ctx, {
    name: 'secureintent-overlay',
    // open only in e2e builds so tests can drive the overlay; closed in production
    mode:
      (import.meta.env as Record<string, string | undefined>).WXT_E2E === '1' ? 'open' : 'closed',
    position: 'overlay',
    zIndex: 2147483647,
    anchor: 'body',
    isolateEvents: true,
    onMount: (container) => {
      const root = createRoot(container);
      root.render(createElement(Overlay, props as OverlayProps));
      return root;
    },
    onRemove: (root) => root?.unmount(),
  });

  ui.mount();
  return { remove: () => ui.remove() };
}
