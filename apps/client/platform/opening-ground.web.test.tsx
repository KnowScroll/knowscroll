/**
 * Web (jest-expo/web, jsdom): the page is the opening's dark ground while it is prepared or plays, and gives
 * its own colours back after.
 */
import { act } from 'react';
import { createRoot } from 'test-renderer';
import { useOpeningGround } from './opening-ground';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Opening({ dark }: { dark: boolean }) {
  useOpeningGround(dark, 'rgb(2, 3, 8)');
  return null;
}

describe('useOpeningGround (web)', () => {
  it('darkens the page while the opening is on and restores it after', () => {
    document.documentElement.style.backgroundColor = 'rgb(255, 255, 255)';
    const root = createRoot();
    act(() => root.render(<Opening dark />));
    expect(document.documentElement.style.backgroundColor).toBe('rgb(2, 3, 8)');
    expect(document.body.style.backgroundColor).toBe('rgb(2, 3, 8)');
    act(() => root.render(<Opening dark={false} />));
    expect(document.documentElement.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(document.body.style.backgroundColor).toBe('');
    act(() => root.unmount());
  });

  it('leaves the page alone when there is no opening', () => {
    document.documentElement.style.backgroundColor = '';
    const root = createRoot();
    act(() => root.render(<Opening dark={false} />));
    expect(document.documentElement.style.backgroundColor).toBe('');
    act(() => root.unmount());
  });
});
