import { act } from 'react';
import { Text } from 'react-native';
import { createRoot, type Root, type TestInstance } from 'test-renderer';
import { DisplayProvider } from '../../display/display';
import { COOL, WARM } from '../picture/palette';
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

/** The phrase's own element, found by its role, with the props the browser would be given. */
function mountPhrase(link: { phrase: string; part: string; tone?: 'warm' | 'cool' } = links[0]!) {
  const onLinkPress = jest.fn();
  const root = mount(<Text>{linkedWords(`Earth is nearest the Sun in ${link.phrase}.`, [link], onLinkPress)}</Text>);
  const phrase = withRole(root, 'button');
  if (phrase === undefined) throw new Error('the phrase is not a button');
  const props = phrase.props as {
    onClick: (event: object) => void;
    onKeyDown: (event: object) => void;
    style: { textDecoration?: string; textDecorationColor?: string };
  } & Record<string, unknown>;
  return { root, phrase, props, onLinkPress };
}

const key = (name: string, repeat = false) => ({ key: name, repeat, preventDefault: jest.fn() });

describe('a linked phrase wraps with its paragraph (#794)', () => {
  it('is an inline span with the button role, not a <button> box that cannot break across lines', () => {
    const { root, phrase } = mountPhrase();
    expect(phrase.type).toBe('span');
    expect(root.container.queryAll((node) => node.type === 'button')).toHaveLength(0);
    // Its words are in the paragraph's own flow: the text before and after it sit beside it in the same parent.
    expect(phrase.children).toEqual(['January']);
    expect(phrase.parent?.children).toContain(phrase);
    expect(phrase.parent?.children.length).toBeGreaterThan(1);
  });

  it('is reached by Tab and named for assistive tech', () => {
    const { props } = mountPhrase();
    expect(props.tabIndex).toBe(0);
    expect(props.role).toBe('button');
    expect(props['aria-label']).toBe('Show January in the picture');
  });

  it('is pressed once by a click, which does not reach the paragraph', () => {
    const { props, onLinkPress } = mountPhrase();
    const stopPropagation = jest.fn();
    act(() => props.onClick({ stopPropagation }));
    expect(onLinkPress).toHaveBeenCalledTimes(1);
    expect(onLinkPress).toHaveBeenCalledWith('jan');
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Enter', 'Enter'],
    ['Space', ' '],
  ])('is pressed by %s once, and a held key does not press again', (_name, name) => {
    const { props, onLinkPress } = mountPhrase();
    const first = key(name);
    act(() => props.onKeyDown(first));
    expect(onLinkPress).toHaveBeenCalledTimes(1);
    expect(onLinkPress).toHaveBeenCalledWith('jan');
    const held = key(name, true);
    act(() => props.onKeyDown(held));
    expect(onLinkPress).toHaveBeenCalledTimes(1);
    // The held key still must not scroll the page.
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(held.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('ignores the other keys, leaving them to the browser', () => {
    const { props, onLinkPress } = mountPhrase();
    const tab = key('Tab');
    act(() => props.onKeyDown(tab));
    expect(onLinkPress).not.toHaveBeenCalled();
    expect(tab.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    ['warm', WARM],
    ['cool', COOL],
  ] as const)('is underlined in the colour of a %s part', (tone, colour) => {
    const { props } = mountPhrase({ phrase: 'January', part: 'jan', tone });
    expect(props.style.textDecoration).toBe('underline');
    expect(props.style.textDecorationColor).toBe(colour);
  });

  it('is underlined in the page link colour when its part has no tone', () => {
    const { props } = mountPhrase();
    expect(props.style.textDecoration).toBe('underline');
    expect([WARM, COOL]).not.toContain(props.style.textDecorationColor);
    expect(props.style.textDecorationColor).toBeTruthy();
  });

  it('is drawn with the web focus ring, which the stylesheet shows on keyboard focus only', () => {
    const { props } = mountPhrase();
    expect(props['data-ks-focus']).toBe('onLight');
  });
});
