import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConsentGate } from './ConsentGate';

afterEach(() => document.body.replaceChildren());

function renderGate(onCancel = vi.fn(), onAgree = vi.fn()) {
  const utils = render(<ConsentGate onAgree={onAgree} onCancel={onCancel} />);
  return { ...utils, onCancel, onAgree };
}

describe('ConsentGate', () => {
  test('"I Agree" accepts the terms', () => {
    const { onAgree, onCancel } = renderGate();
    fireEvent.click(screen.getByText('I Agree & Enable Protection'));
    expect(onAgree).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('"Not now" dismisses', () => {
    const { onCancel, onAgree } = renderGate();
    fireEvent.click(screen.getByText('Not now'));
    expect(onCancel).toHaveBeenCalled();
    expect(onAgree).not.toHaveBeenCalled();
  });

  // The three escape hatches every other overlay has, and this one used to lack.
  test('Escape dismisses', () => {
    const { onCancel } = renderGate();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  test('the × dismisses', () => {
    const { onCancel } = renderGate();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  test('clicking the scrim dismisses, clicking the dialog does not', () => {
    const { container, onCancel } = renderGate();
    fireEvent.click(screen.getByRole('alertdialog'));
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector('.si-scrim')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('says what dismissing does to the paste', () => {
    renderGate();
    expect(screen.getByText(/discards the paste you just made/i)).toBeTruthy();
    expect(screen.getByText(/nothing is inserted/i)).toBeTruthy();
  });

  test('file consent explains that dismissing cancels the file upload', () => {
    render(<ConsentGate contentKind="file" onAgree={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /before we check this file/i })).toBeTruthy();
    expect(screen.getByText(/cancels the selected file/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /file upload is cancelled/i })).toBeTruthy();
  });

  test('the Escape listener is removed on unmount', () => {
    const { unmount, onCancel } = renderGate();
    unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
