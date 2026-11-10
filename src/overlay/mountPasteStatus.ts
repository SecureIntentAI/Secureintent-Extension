import { type ContentScriptContext, createShadowRootUi } from '#imports';

export type PasteStatus =
  | 'checking'
  | 'too-large'
  | 'partly-checked'
  | 'busy'
  | 'expired'
  | 'error';

/** The most characters one paste or file is checked for; the rest is not read. */
export const CHECK_LIMIT_LABEL = '2 million characters';

const messages: Record<PasteStatus, [string, string]> = {
  error: [
    'Paste could not be completed',
    'SecureIntent could not confirm the paste. Check the editor before trying again.',
  ],
  busy: [
    'Too many pending pastes',
    'This additional paste was not queued. Finish the current paste, then try again.',
  ],
  expired: [
    'Pending paste expired',
    'Paste the text again so SecureIntent can check it at the current cursor position.',
  ],
  checking: ['Checking paste…', 'You can cancel while SecureIntent checks this text.'],
  'too-large': [
    'Paste could not be queued',
    `This paste arrived while another was being checked and is over ${CHECK_LIMIT_LABEL}, so it was not kept. Paste it again.`,
  ],
  'partly-checked': [
    'Only part of this paste was checked',
    `SecureIntent checks up to ${CHECK_LIMIT_LABEL}. Nothing was found in that part. The rest of the paste was not checked and may contain secrets.`,
  ],
};

/** Lightweight status: it can paint before scanning and contains no pasted data. */
export async function mountPasteStatus(
  ctx: ContentScriptContext,
  initial: PasteStatus,
  onCancel: () => void,
  /** When given, a second button pastes anyway; the first then cancels. */
  onConfirm?: () => void,
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
      button.textContent = initial === 'checking' || onConfirm ? 'Cancel' : 'Dismiss';
      panel.append(title, description, button);
      if (onConfirm) {
        const confirm = document.createElement('button');
        confirm.className = 'si-btn si-btn-danger';
        confirm.type = 'button';
        confirm.textContent = 'Paste anyway';
        confirm.addEventListener('click', onConfirm);
        panel.append(confirm);
      }
      scrim.append(panel);
      container.append(scrim);
    },
  });
  ui.mount();
  return { remove: () => ui.remove() };
}
