import { act } from 'react';
import { Text } from 'react-native';
import { createRoot, type Root, type TestInstance } from 'test-renderer';
import { DisplayProvider } from '../../display/display';
import { linkedWords } from './linked-text';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const links = [{ phrase: 'January', part: 'jan' }];

function mount(node: React.ReactNode): Root {
  const root = createRoot();
  act(() => {
    root.render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>);
  });
  return root;
}

const withRole = (root: Root, role: string): TestInstance | undefined =>
  root.container.queryAll((node) => (node.props as { role?: string }).role === role)[0];

describe('a linked phrase in the browser (document v3)', () => {
  it('is a focusable button, pressed by a click, Enter and Space', () => {
    const onLinkPress = jest.fn();
    const root = mount(<Text>{linkedWords('Earth is nearest the Sun in January.', links, onLinkPress)}</Text>);
    const phrase = withRole(root, 'button');
    const props = phrase?.props as Record<string, unknown> & {
      onClick: (event: object) => void;
      onKeyDown: (event: object) => void;
    };
    expect(props['aria-label'] ?? props.accessibilityLabel).toBe('Show January in the picture');
    expect(props.tabIndex).toBe(0);
    act(() => props.onClick({ stopPropagation: jest.fn() }));
    act(() => props.onKeyDown({ key: 'Enter', preventDefault: jest.fn(), nativeEvent: { key: 'Enter' } }));
    act(() => props.onKeyDown({ key: ' ', preventDefault: jest.fn(), nativeEvent: { key: ' ' } }));
    expect(onLinkPress).toHaveBeenCalledTimes(3);
    expect(onLinkPress).toHaveBeenCalledWith('jan');
  });
});
