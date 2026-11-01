import { act } from 'react';
import { createRoot, type Root, type TestInstance } from 'test-renderer';
import { SelectionMenu } from './selection-menu';
import { selectedInReadStop } from './selection-menu.web';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Writes one stop into the page and selects its words, the way a drag across them does. */
function selectWordsIn(kind: 'read' | 'call' | 'end', stopId: string, words: string): void {
  document.body.innerHTML = `<div data-ks-stop="${stopId}" data-ks-kind="${kind}"><p id="words">${words}</p></div>`;
  const text = document.getElementById('words')!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, words.length);
  range.getBoundingClientRect = () => ({ left: 100, top: 200, width: 80, height: 20 }) as DOMRect;
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

const buttons = (root: Root): TestInstance[] => root.container.queryAll((node) => node.type === 'button');

describe('what the selection menu acts on (web)', () => {
  it('is the stop the words are in and the words, for a read stop', () => {
    selectWordsIn('read', 'the-lean', 'Earth is tilted');
    expect(selectedInReadStop()).toMatchObject({ stopId: 'the-lean', text: 'Earth is tilted' });
  });

  it('is nothing for the words of a call, the end, or no selection', () => {
    selectWordsIn('call', 'call-delhi', 'Why is June hot in Delhi?');
    expect(selectedInReadStop()).toBeUndefined();
    selectWordsIn('end', 'end', 'The picture you built');
    expect(selectedInReadStop()).toBeUndefined();
    window.getSelection()!.removeAllRanges();
    expect(selectedInReadStop()).toBeUndefined();
  });
});

describe('the selection menu (web)', () => {
  it('offers Simpler and Ask over words in a read stop, and acts on that stop with the selected words', () => {
    const onSimpler = jest.fn();
    const onAsk = jest.fn();
    const root = createRoot();
    act(() => {
      root.render(<SelectionMenu onSimpler={onSimpler} onAsk={onAsk} />);
    });
    expect(buttons(root)).toHaveLength(0);
    selectWordsIn('read', 'the-lean', 'Earth is tilted');
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(buttons(root).map((button) => button.toJSON()?.children)).toEqual([['Simpler'], ['Ask']]);
    act(() => {
      (buttons(root)[1]!.props as { onClick: () => void }).onClick();
    });
    expect(onAsk).toHaveBeenCalledWith('the-lean', 'Earth is tilted');
    expect(onSimpler).not.toHaveBeenCalled();
    // Acting puts the menu and the selection away.
    expect(buttons(root)).toHaveLength(0);
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });

  it('offers Simpler alone where the screen has no Ask', () => {
    const root = createRoot();
    act(() => {
      root.render(<SelectionMenu onSimpler={jest.fn()} />);
    });
    selectWordsIn('read', 'the-lean', 'Earth is tilted');
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(buttons(root).map((button) => button.toJSON()?.children)).toEqual([['Simpler']]);
  });

  it('runs Simpler for the stop alone', () => {
    const onSimpler = jest.fn();
    const root = createRoot();
    act(() => {
      root.render(<SelectionMenu onSimpler={onSimpler} onAsk={jest.fn()} />);
    });
    selectWordsIn('read', 'same-direction', 'keeps its direction');
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    act(() => {
      (buttons(root)[0]!.props as { onClick: () => void }).onClick();
    });
    expect(onSimpler).toHaveBeenCalledWith('same-direction');
  });

  it('is not offered over the words of a call, whose text could give the answer away', () => {
    const root = createRoot();
    act(() => {
      root.render(<SelectionMenu onSimpler={jest.fn()} onAsk={jest.fn()} />);
    });
    selectWordsIn('call', 'call-delhi', 'Why is June hot in Delhi?');
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(buttons(root)).toHaveLength(0);
  });

  it('goes when the selection does', () => {
    const root = createRoot();
    act(() => {
      root.render(<SelectionMenu onSimpler={jest.fn()} onAsk={jest.fn()} />);
    });
    selectWordsIn('read', 'the-lean', 'Earth is tilted');
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(buttons(root)).toHaveLength(2);
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(buttons(root)).toHaveLength(0);
  });
});
