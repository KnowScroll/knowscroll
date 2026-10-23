import { act, useState, type ReactNode } from 'react';
// ReactDOM is already an app dependency. This narrow test-only facade avoids adding a types dependency.
const { createRoot } = jest.requireActual<{
  createRoot: (container: HTMLElement) => { render: (children: ReactNode) => void; unmount: () => void };
}>('react-dom/client');
import { EncounterOverlay } from '../features/encounter/encounter-overlay.web';
import { RequestChoices } from '../features/requests/request-choices';

// The UI barrel loads the SVG adapter, whose numeric asset lookup is absent in web Jest.
// This fixture renders no image assets. Fail if that unrelated path is ever exercised.
jest.mock(
  '@react-native/assets-registry/registry',
  () => ({
    getAssetByID: () => {
      throw new Error('This DOM keyboard fixture must not load numeric image assets');
    },
  }),
  { virtual: true },
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** DOM fixture only: jsdom has no layout, so visible controls receive nonempty test geometry. */
describe('actual request sheet and radio keyboard ownership (web DOM)', () => {
  it('moves exclusive selection/focus, traps Tab, closes on Esc and returns to Ask without writing private history', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const push = jest.spyOn(window.history, 'pushState');
    const replace = jest.spyOn(window.history, 'replaceState');
    const rects = jest.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({
      0: new DOMRect(0, 0, 100, 48),
      length: 1,
      item: () => new DOMRect(0, 0, 100, 48),
      [Symbol.iterator]: () => [new DOMRect(0, 0, 100, 48)][Symbol.iterator](),
    });
    const priorHistory = window.history.state as unknown;
    const priorUrl = window.location.href;
    let closes = 0;
    function Fixture() {
      const [open, setOpen] = useState(false);
      const [format, setFormat] = useState<'reel' | 'scroll' | 'either'>('either');
      const close = () => {
        closes += 1;
        setOpen(false);
      };
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Ask
          </button>
          {open ? (
            <EncounterOverlay label="Ask for something" presentation="sheet" onClose={close}>
              <div>
                <button type="button" onClick={close}>
                  Close request
                </button>
                <textarea aria-label="What would you like now?" defaultValue="private draft, only memory" />
                <RequestChoices
                  label="Requested format"
                  options={[
                    { value: 'reel', label: 'Reel' },
                    { value: 'scroll', label: 'Scroll' },
                    { value: 'either', label: 'Either' },
                  ]}
                  value={format}
                  disabled={false}
                  onSelect={setFormat}
                />
                <button type="button">Send request</button>
              </div>
            </EncounterOverlay>
          ) : null}
        </>
      );
    }
    const key = (target: Element, value: string, shiftKey = false) =>
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
      });
    try {
      act(() => root.render(<Fixture />));
      const ask = container.querySelector<HTMLButtonElement>('button')!;
      ask.focus();
      act(() => ask.click());
      const sheet = container.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(sheet.getAttribute('aria-label')).toBe('Ask for something');
      expect(document.activeElement).toBe(container.querySelector('textarea'));
      const radios = () => [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
      const checked = () => radios().filter((radio) => radio.getAttribute('aria-checked') === 'true');
      expect(checked()).toHaveLength(1);
      expect(checked()[0]!.textContent).toBe('Either');
      expect(radios().filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
      act(() => checked()[0]!.focus());
      key(checked()[0]!, 'ArrowRight');
      expect(checked()[0]!.textContent).toBe('Reel');
      expect(document.activeElement).toBe(checked()[0]);
      key(checked()[0]!, 'End');
      expect(checked()[0]!.textContent).toBe('Either');
      expect(document.activeElement).toBe(checked()[0]);
      key(checked()[0]!, 'Home');
      expect(checked()[0]!.textContent).toBe('Reel');
      expect(document.activeElement).toBe(checked()[0]);
      key(checked()[0]!, 'ArrowLeft');
      expect(checked()[0]!.textContent).toBe('Either');
      expect(document.activeElement).toBe(checked()[0]);
      const close = sheet.querySelector<HTMLButtonElement>('button')!;
      const send = [...sheet.querySelectorAll<HTMLButtonElement>('button')].at(-1)!;
      act(() => send.focus());
      key(send, 'Tab');
      expect(document.activeElement).toBe(close);
      key(close, 'Tab', true);
      expect(document.activeElement).toBe(send);
      key(send, 'Escape');
      expect(closes).toBe(1);
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(ask);
      expect(push).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(window.history.state).toEqual(priorHistory);
      expect(window.location.href).toBe(priorUrl);
      expect(JSON.stringify([window.history.state, window.location.href])).not.toContain('private draft');
    } finally {
      act(() => root.unmount());
      container.remove();
      push.mockRestore();
      replace.mockRestore();
      rects.mockRestore();
    }
  });
});
