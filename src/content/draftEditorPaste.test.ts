import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { pasteIntoDraft } from './draftEditorPaste';

// jsdom has selection/range APIs, but no clipboard event/data constructors.
class ClipboardData {
  private data = new Map<string, string>();

  get types(): string[] {
    return Array.from(this.data.keys());
  }

  setData(type: string, value: string): void {
    this.data.set(type, value);
  }

  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
}

class PasteEvent extends Event {
  readonly clipboardData: DataTransfer | null;

  constructor(type: string, init: ClipboardEventInit = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}

function renderBlocks(editor: HTMLElement, lines: string[]): HTMLElement[] {
  const blocks = lines.map((line) => {
    const block = document.createElement('div');
    block.dataset.block = 'true';
    const leaf = document.createElement('span');
    leaf.dataset.text = 'true';
    leaf.textContent = line;
    block.append(leaf);
    return block;
  });
  editor.replaceChildren(...blocks);
  return blocks;
}

function select(start: Node, startOffset: number, end = start, endOffset = startOffset): void {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function setup(lines = ['Before after']) {
  const editor = document.createElement('div');
  editor.className = 'public-DraftEditor-content';
  editor.setAttribute('contenteditable', 'true');
  document.body.append(editor);
  const blocks = renderBlocks(editor, lines);
  const text = blocks[0].firstChild!.firstChild ?? blocks[0].firstChild!;
  select(text, lines[0].length);
  return { editor, blocks, text };
}

let execCommand: ReturnType<typeof vi.fn>;
let execCommandDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.stubGlobal('DataTransfer', ClipboardData);
  vi.stubGlobal('ClipboardEvent', PasteEvent);
  execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
  execCommand = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
});

afterEach(() => {
  expect(execCommand).not.toHaveBeenCalled();
  if (execCommandDescriptor) {
    Object.defineProperty(document, 'execCommand', execCommandDescriptor);
  } else {
    Reflect.deleteProperty(document, 'execCommand');
  }
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('checked paste into a controlled Draft editor', () => {
  test('an ignored synthetic paste fails without direct DOM insertion', async () => {
    const { editor } = setup();
    const initial = editor.innerHTML;
    const handler = vi.fn();
    editor.addEventListener('paste', handler);

    const assertion = expect(pasteIntoDraft(editor, 'checked text', () => true)).rejects.toThrow(
      'The editor refused the checked paste',
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(handler).toHaveBeenCalledOnce();
    expect(editor.innerHTML).toBe(initial);
  });

  test('preventDefault without a controlled commit is rejected after a bounded wait', async () => {
    const { editor } = setup();
    const initial = editor.innerHTML;
    editor.addEventListener('paste', (event) => event.preventDefault());

    const assertion = expect(pasteIntoDraft(editor, 'checked text', () => true)).rejects.toThrow(
      'The editor did not accept the checked text',
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(performance.now()).toBeGreaterThanOrEqual(250);
    expect(performance.now()).toBeLessThan(300);
    expect(editor.innerHTML).toBe(initial);
  });

  test('cancellation during selection synchronization prevents replay', async () => {
    const { editor } = setup();
    const handler = vi.fn();
    editor.addEventListener('paste', handler);
    let current = true;

    const pending = pasteIntoDraft(editor, 'checked text', () => current);
    current = false;
    const assertion = expect(pending).rejects.toThrow('The pending paste was cancelled');
    await vi.runAllTimersAsync();
    await assertion;

    expect(handler).not.toHaveBeenCalled();
  });

  test('an editor removed before replay receives no clipboard event', async () => {
    const { editor } = setup();
    const handler = vi.fn();
    editor.addEventListener('paste', handler);

    const pending = pasteIntoDraft(editor, 'checked text', () => true);
    editor.remove();
    const assertion = expect(pending).rejects.toThrow('The pending paste was cancelled');
    await vi.runAllTimersAsync();
    await assertion;

    expect(handler).not.toHaveBeenCalled();
  });

  test('a changed selection during the initial wait prevents insertion at the wrong position', async () => {
    const { editor, text } = setup();
    const handler = vi.fn();
    editor.addEventListener('paste', handler);

    const pending = pasteIntoDraft(editor, 'checked text', () => true);
    select(text, 0);
    const assertion = expect(pending).rejects.toThrow(
      'The saved paste position is no longer available',
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(handler).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('Before after');
  });

  test('changed content during the initial wait is not overwritten', async () => {
    const { editor, text } = setup();
    select(text, 0);
    const handler = vi.fn();
    editor.addEventListener('paste', handler);

    const pending = pasteIntoDraft(editor, 'checked text', () => true);
    renderBlocks(editor, ['User typed new text']);
    select(editor.firstChild!.firstChild!.firstChild!, 0);
    const assertion = expect(pending).rejects.toThrow(
      'The saved paste position is no longer available',
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(handler).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('User typed new text');
  });

  test('cancellation while awaiting a controlled commit fails without fallback', async () => {
    const { editor } = setup();
    let current = true;
    editor.addEventListener('paste', (event) => {
      event.preventDefault();
      setTimeout(() => {
        current = false;
      }, 20);
    });

    const assertion = expect(pasteIntoDraft(editor, 'checked text', () => current)).rejects.toThrow(
      'The pending paste was cancelled',
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(editor.textContent).toBe('Before after');
    expect(performance.now()).toBeLessThan(250);
  });

  test('waits for delayed controlled rendering and shares only the checked plain text', async () => {
    const { editor, text } = setup();
    select(text, 7, text, 12);
    const checked = 'checked <b>literal</b> text';
    let clipboard: DataTransfer | null = null;
    let inserting = false;
    editor.addEventListener('paste', (event) => {
      expect(inserting).toBe(true);
      event.preventDefault();
      clipboard = (event as ClipboardEvent).clipboardData;
      setTimeout(() => {
        expect(inserting).toBe(false);
        renderBlocks(editor, ['Before checked <b>literal</b> text']);
      }, 48);
    });
    const settled = vi.fn();

    const pending = pasteIntoDraft(
      editor,
      checked,
      () => {
        expect(inserting).toBe(false);
        return true;
      },
      (action) => {
        inserting = true;
        try {
          return action();
        } finally {
          inserting = false;
        }
      },
    ).then(settled);
    await vi.advanceTimersByTimeAsync(32);
    expect(settled).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('Before after');
    await vi.runAllTimersAsync();
    await pending;

    expect(settled).toHaveBeenCalledOnce();
    expect(clipboard!.types).toEqual(['text/plain']);
    expect(clipboard!.getData('text/plain')).toBe(checked);
    expect(clipboard!.getData('text/html')).toBe('');
    expect(editor.querySelector('b')).toBeNull();
  });

  test('accepts CRLF normalization while preserving blank and trailing blocks', async () => {
    const { editor, text } = setup(['replace']);
    select(text, 0, text, 7);
    editor.addEventListener('paste', (event) => {
      event.preventDefault();
      renderBlocks(editor, ['', 'first', '', 'last', '']);
    });

    const pending = pasteIntoDraft(editor, '\r\nfirst\r\n\r\nlast\r', () => true);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();

    expect(editor.querySelectorAll('[data-block="true"]')).toHaveLength(5);
  });

  test('accounts for blank block separators when replacing a selection spanning blocks', async () => {
    const { editor, blocks } = setup(['head ABC', '', 'XYZ tail']);
    select(blocks[0].firstChild!.firstChild!, 5, blocks[2].firstChild!.firstChild!, 3);
    editor.addEventListener('paste', (event) => {
      event.preventDefault();
      renderBlocks(editor, ['head one', '', 'two tail']);
    });

    const pending = pasteIntoDraft(editor, 'one\n\ntwo', () => true);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
  });

  test("does not count Draft's trailing soft-newline caret sentinel as model content or selection offset", async () => {
    // Draft renders a second newline after a final soft newline to draw the caret.
    const { editor, blocks } = setup(['head\n\n', 'tail']);
    select(blocks[0].firstChild!.firstChild!, 6);
    editor.addEventListener('paste', (event) => {
      event.preventDefault();
      renderBlocks(editor, ['head\nX', 'tail']);
    });

    const pending = pasteIntoDraft(editor, 'X', () => true);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
  });

  test('a handler that cancels the pending job cannot report success even if rendered text matches', async () => {
    const { editor, text } = setup(['replace']);
    select(text, 0, text, 7);
    let current = true;
    editor.addEventListener('paste', (event) => {
      event.preventDefault();
      renderBlocks(editor, ['checked']);
      current = false;
    });

    const assertion = expect(pasteIntoDraft(editor, 'checked', () => current)).rejects.toThrow(
      'The pending paste was cancelled',
    );
    await vi.runAllTimersAsync();
    await assertion;
  });

  test('does not report success when a handled paste commits the wrong content', async () => {
    const { editor, text } = setup(['replace']);
    select(text, 0, text, 7);
    editor.addEventListener('paste', (event) => {
      event.preventDefault();
      renderBlocks(editor, ['checkedtext']);
    });

    const assertion = expect(pasteIntoDraft(editor, 'checked\ntext', () => true)).rejects.toThrow(
      'The editor did not accept the checked text',
    );
    await vi.runAllTimersAsync();
    await assertion;
  });
});
