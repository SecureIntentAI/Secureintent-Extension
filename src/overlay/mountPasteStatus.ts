import { type ContentScriptContext, createShadowRootUi } from '#imports';

export type PasteStatus = 'checking' | 'too-large';

const messages: Record<PasteStatus, [string, string]> = {
  checking: ['Checking paste…', 'You can cancel while SecureIntent checks this text.'],
  'too-large': [
    'Paste is too large',
    'Paste a smaller section, up to 2 million characters, so SecureIntent can check it safely.',
  ],
};

/** Lightweight status: it can paint before scanning and contains no pasted data. */
export async function mountPasteStatus(
  ctx: ContentScriptContext,
  initial: PasteStatus,
  onCancel: () => void,
) {
  const ui = await createShadowRootUi(ctx, {
    name: 'secureintent-paste-status',
    mode:
      (import.meta.env as Record<string, string | undefined>).WXT_E2E === '1' ? 'open' : 'closed',
    position: 'overlay',
    zIndex: 2147483647,
    anchor: 'body',
    isolateEvents: true,
    onMount(container) {
      const scrim = document.createElement('div');
      scrim.className = 'si-scrim';
      const panel = document.createElement('div');
      panel.className = 'si-hud si-paste-status';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', 'SecureIntent paste status');
      const title = document.createElement('h2');
      const description = document.createElement('p');
      description.setAttribute('role', 'status');
      const button = document.createElement('button');
      button.className = 'si-btn si-btn-ghost';
      button.type = 'button';
      button.addEventListener('click', onCancel);
      [title.textContent, description.textContent] = messages[initial];
      button.textContent = initial === 'checking' ? 'Cancel' : 'Dismiss';
      panel.append(title, description, button);
      scrim.append(panel);
      container.append(scrim);
    },
  });
  ui.mount();
  return { remove: () => ui.remove() };
}
