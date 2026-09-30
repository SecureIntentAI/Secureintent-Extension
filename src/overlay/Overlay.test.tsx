import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Detection } from '@/lib/detection';
import { Overlay, type OverlayAction } from './Overlay';

const secret = 'sk-' + 'a'.repeat(30);
const text = `here is ${secret} ok`;
const start = text.indexOf(secret);
const detections: Detection[] = [
  { type: 'known-key', label: 'OpenAI API key', match: secret, start, end: start + secret.length },
];

function renderOverlay(onAction: (a: OverlayAction) => void = () => {}, pro = true) {
  return render(
    <Overlay site="ChatGPT" text={text} detections={detections} pro={pro} onAction={onAction} />,
  );
}

afterEach(() => document.body.replaceChildren());

describe('Overlay', () => {
  test('moves focus to Cancel, contains Tab navigation, and restores focus on unmount', () => {
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    const { unmount } = renderOverlay();
    expect(document.activeElement).toBe(screen.getByText('Cancel'));
    const last = screen.getByText('Paste anonymously');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Cancel'));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    unmount();
    expect(document.activeElement).toBe(editor);
  });

  test('shows each detection label and an accessible name with the site', () => {
    renderOverlay();
    expect(screen.getByText('OpenAI API key')).toBeTruthy();
    expect(screen.getByRole('alertdialog', { name: /ChatGPT/ })).toBeTruthy();
  });

  test('never renders the raw secret', () => {
    const { container } = renderOverlay();
    expect(container.textContent).not.toContain(secret);
  });

  test('"Paste anyway" emits the paste action', () => {
    const onAction = vi.fn();
    renderOverlay(onAction);
    fireEvent.click(screen.getByText('Paste anyway'));
    expect(onAction).toHaveBeenCalledWith('paste');
  });

  test('"Paste anonymously" emits the redact action', () => {
    const onAction = vi.fn();
    renderOverlay(onAction);
    fireEvent.click(screen.getByText('Paste anonymously'));
    expect(onAction).toHaveBeenCalledWith('redact');
  });

  test('"Cancel" emits the cancel action', () => {
    const onAction = vi.fn();
    renderOverlay(onAction);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onAction).toHaveBeenCalledWith('cancel');
  });

  test('Escape key emits the cancel action', () => {
    const onAction = vi.fn();
    renderOverlay(onAction);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onAction).toHaveBeenCalledWith('cancel');
  });

  test('shows the line number in the header, always visible', () => {
    const multiline = `first\nsecond\nkey ${secret} end`;
    const at = multiline.indexOf(secret);
    const dets: Detection[] = [
      {
        type: 'known-key',
        label: 'OpenAI API key',
        match: secret,
        start: at,
        end: at + secret.length,
      },
    ];
    render(<Overlay site="ChatGPT" text={multiline} detections={dets} onAction={() => {}} />);

    // Line number lives in the header meta now, not behind the expander.
    expect(screen.getByText(/line 3/i)).toBeTruthy();
  });

  test('summary (Ghost) mode shows category counts instead of a finding list', () => {
    render(
      <Overlay
        site="ChatGPT"
        text={text}
        detections={detections}
        summary={{
          total: 3,
          items: [
            { label: 'Internal IP', count: 2 },
            { label: 'Email address', count: 1 },
          ],
        }}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText(/Internal IP/)).toBeTruthy();
    expect(screen.getByText(/2/)).toBeTruthy();
    expect(screen.getByText(/Email address/)).toBeTruthy();
  });

  test('summary mode "Sanitize & paste" emits the sanitize action', () => {
    const onAction = vi.fn();
    render(
      <Overlay
        site="ChatGPT"
        text={text}
        detections={detections}
        summary={{ total: 1, items: [{ label: 'Internal IP', count: 1 }] }}
        pro
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByText('Sanitize & paste'));
    expect(onAction).toHaveBeenCalledWith('sanitize');
  });

  test('summary mode never renders the raw secret', () => {
    const { container } = render(
      <Overlay
        site="ChatGPT"
        text={text}
        detections={detections}
        summary={{ total: 1, items: [{ label: 'OpenAI API key', count: 1 }] }}
        onAction={() => {}}
      />,
    );
    expect(container.textContent).not.toContain(secret);
  });

  test('blockRawPaste (team policy) removes "Paste anyway" but keeps the other outcomes', () => {
    const onAction = vi.fn();
    render(
      <Overlay
        site="ChatGPT"
        text={text}
        detections={detections}
        pro
        blockRawPaste
        onAction={onAction}
      />,
    );
    expect(screen.queryByText('Paste anyway')).toBeNull();
    expect(screen.getByText(/team's policy blocks pasting/i)).toBeTruthy();

    fireEvent.click(screen.getByText('Paste anonymously'));
    expect(onAction).toHaveBeenCalledWith('redact');
    fireEvent.click(screen.getByText('Cancel'));
    expect(onAction).toHaveBeenCalledWith('cancel');
  });

  test('blockRawPaste also removes "Paste anyway" from the Ghost summary', () => {
    render(
      <Overlay
        site="ChatGPT"
        text={text}
        detections={detections}
        summary={{ total: 1, items: [{ label: 'Internal IP', count: 1 }] }}
        pro
        blockRawPaste
        onAction={() => {}}
      />,
    );
    expect(screen.queryByText('Paste anyway')).toBeNull();
    expect(screen.getByText('Sanitize & paste')).toBeTruthy();
  });

  test('policyBlock renders a block notice with no paste route at all', () => {
    const onAction = vi.fn();
    render(
      <Overlay
        site="Pastebin"
        text={text}
        detections={detections}
        pro
        policyBlock={{ host: 'pastebin.com' }}
        onAction={onAction}
      />,
    );
    expect(screen.getByText('pastebin.com')).toBeTruthy();
    expect(screen.getByText('Team policy')).toBeTruthy();
    expect(screen.queryByText('Paste anyway')).toBeNull();
    expect(screen.queryByText('Paste anonymously')).toBeNull();
    expect(screen.queryByText('Sanitize & paste')).toBeNull();

    fireEvent.click(screen.getByText('Dismiss'));
    expect(onAction).toHaveBeenCalledWith('cancel');
  });

  test('policyBlock outranks the Ghost summary and never renders the raw secret', () => {
    const { container } = render(
      <Overlay
        site="Pastebin"
        text={text}
        detections={detections}
        summary={{ total: 1, items: [{ label: 'OpenAI API key', count: 1 }] }}
        pro
        policyBlock={{ host: 'pastebin.com' }}
        onAction={() => {}}
      />,
    );
    expect(screen.queryByText('Sanitize & paste')).toBeNull();
    expect(container.textContent).not.toContain(secret);
  });

  test('free user who never had Pro sees the plain Pro upsell', () => {
    const onAction = vi.fn();
    renderOverlay(onAction, false);
    fireEvent.click(screen.getByText('Paste anonymously · Pro'));
    expect(onAction).toHaveBeenCalledWith('upgrade');
    expect(screen.queryByText(/free Anonymise & Paste this month/i)).toBeNull();
  });

  test('spent monthly allowance says so, names the reset date, and still routes to upgrade', () => {
    const onAction = vi.fn();
    render(
      <Overlay
        site="ChatGPT"
        text={text}
        detections={detections}
        pro={false}
        quotaExhausted={{ limit: 10, resetsOn: 'Sep 1' }}
        onAction={onAction}
      />,
    );

    // The user is told what ran out and when it comes back — not just "Pro".
    expect(screen.getByText(/used all 10 free Anonymise & Paste this month/i)).toBeTruthy();
    expect(screen.getByText('Sep 1')).toBeTruthy();
    // ...and the CTA is no longer identical to the never-had-it one.
    expect(screen.queryByText('Paste anonymously · Pro')).toBeNull();
    fireEvent.click(screen.getByText('Upgrade for unlimited'));
    expect(onAction).toHaveBeenCalledWith('upgrade');
  });

  test('a Pro user never sees the quota notice', () => {
    render(
      <Overlay
        site="ChatGPT"
        text={text}
        detections={detections}
        pro
        quotaExhausted={{ limit: 10, resetsOn: 'Sep 1' }}
        onAction={() => {}}
      />,
    );
    expect(screen.queryByText(/free Anonymise & Paste this month/i)).toBeNull();
    expect(screen.getByText('Paste anonymously')).toBeTruthy();
  });

  // Team rules (Business): a finding from a rule the member's own admin wrote is
  // badged; everything from the default catalogue looks exactly as it did.
  test('a team-pattern finding is badged "Team rule"', () => {
    const dets: Detection[] = [{ ...detections[0], label: 'Acme internal token', origin: 'team' }];
    render(<Overlay site="ChatGPT" text={text} detections={dets} onAction={() => {}} />);
    expect(screen.getByText('Team rule')).toBeTruthy();
  });

  test('a default-catalogue finding is not badged', () => {
    const { container } = renderOverlay();
    expect(screen.queryByText('Team rule')).toBeNull();
    expect(container.querySelector('.si-team-tag')).toBeNull();
  });

  test('only the team finding is badged when both kinds are present', () => {
    const teamSecret = 'ACME-4F2K9Z7Q1B3D';
    const both = `${text} and ${teamSecret}`;
    const at = both.indexOf(teamSecret);
    const dets: Detection[] = [
      detections[0],
      {
        type: 'known-key',
        label: 'Acme internal token',
        match: teamSecret,
        start: at,
        end: at + teamSecret.length,
        origin: 'team',
      },
    ];
    const { container } = render(
      <Overlay site="ChatGPT" text={both} detections={dets} onAction={() => {}} />,
    );
    expect(container.querySelectorAll('.si-team-tag')).toHaveLength(1);
    // The badge is static text — it never leaks any part of what matched.
    expect(container.querySelector('.si-team-tag')?.textContent).toBe('Team rule');
    expect(container.textContent).not.toContain(teamSecret);
    expect(container.textContent).not.toContain(secret);
  });

  test('the Ghost summary badges a team-rule category and leaves the others alone', () => {
    const { container } = render(
      <Overlay
        site="ChatGPT"
        text={text}
        detections={detections}
        summary={{
          total: 3,
          items: [
            { label: 'Acme internal token', count: 2, origin: 'team' },
            { label: 'Email address', count: 1 },
          ],
        }}
        onAction={() => {}}
      />,
    );
    expect(container.querySelectorAll('.si-team-tag')).toHaveLength(1);
    expect(screen.getByText('Team rule')).toBeTruthy();
    expect(container.textContent).not.toContain(secret);
  });

  test('a Ghost summary with no team categories shows no badge', () => {
    const { container } = render(
      <Overlay
        site="ChatGPT"
        text={text}
        detections={detections}
        summary={{ total: 1, items: [{ label: 'Internal IP', count: 1 }] }}
        onAction={() => {}}
      />,
    );
    expect(container.querySelector('.si-team-tag')).toBeNull();
  });

  test('clicking a finding expands a masked snippet without the raw secret', () => {
    const multiline = `first\nsecond\nkey ${secret} end`;
    const at = multiline.indexOf(secret);
    const dets: Detection[] = [
      {
        type: 'known-key',
        label: 'OpenAI API key',
        match: secret,
        start: at,
        end: at + secret.length,
      },
    ];
    const { container } = render(
      <Overlay site="ChatGPT" text={multiline} detections={dets} onAction={() => {}} />,
    );

    expect(container.querySelector('.si-snippet')).toBeNull();
    fireEvent.click(screen.getByText('OpenAI API key'));

    expect(container.querySelector('.si-snippet')).toBeTruthy();
    expect(screen.getByRole('alertdialog').textContent).not.toContain(secret);
  });
});
