/**
 * Web-only modules (jest-expo/web, jsdom): what React Native Web receives for links, ARIA states
 * and focus. The browser behaviour itself (Enter on a link, Tab order) is covered by the
 * Playwright smoke over the production export (apps/client/e2e).
 */
import type { GestureResponderEvent } from 'react-native';
import { useFocusRing } from './focus-ring';
import { linkPress } from './link';
import {
  describedByElement,
  descriptionSemantics,
  destinationSemantics,
  dialogHostSemantics,
  dialogSemantics,
  linkSemantics,
  radioGroupSemantics,
  radioSemantics,
  toggleSemantics,
} from './semantics';

interface FakeClick {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

function click(fields: FakeClick = {}) {
  const preventDefault = jest.fn();
  return { event: { button: 0, ...fields, preventDefault } as unknown as GestureResponderEvent, preventDefault };
}

describe('linkPress (web)', () => {
  it('renders an address, so React Native Web draws a real <a href>', () => {
    expect(linkPress({ href: '/saved', onNavigate: () => undefined })).toMatchObject({ href: '/saved' });
  });

  it('takes over a plain click or Enter for client-side navigation', () => {
    const onNavigate = jest.fn();
    const { event, preventDefault } = click();
    linkPress({ href: '/saved', onNavigate }).onPress(event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it.each<[string, FakeClick]>([
    ['Ctrl-click', { ctrlKey: true }],
    ['Cmd-click', { metaKey: true }],
    ['Shift-click', { shiftKey: true }],
    ['Alt-click', { altKey: true }],
    ['middle click', { button: 1 }],
    ['an already handled click', { defaultPrevented: true }],
  ])('leaves %s to the browser (new tab, new window)', (_name, fields) => {
    const onNavigate = jest.fn();
    const { event, preventDefault } = click(fields);
    linkPress({ href: '/saved', onNavigate }).onPress(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('without an address it is a plain press', () => {
    const onNavigate = jest.fn();
    const props = linkPress({ onNavigate });
    props.onPress(click().event);
    expect(props).not.toHaveProperty('href');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('semantics (web)', () => {
  it('makes destinations links with aria-current when they have an address, buttons otherwise', () => {
    expect(destinationSemantics(true, true)).toEqual({ role: 'link', 'aria-current': 'page' });
    expect(destinationSemantics(false, true)).toEqual({ role: 'link', 'aria-current': undefined });
    // A link-role element without href ignores Enter in React Native Web, so it must be a button.
    expect(destinationSemantics(true, false)).toEqual({ role: 'button', 'aria-current': 'page' });
    expect(linkSemantics(true)).toEqual({ role: 'link' });
    expect(linkSemantics(false)).toEqual({ role: 'button' });
  });

  it('uses aria-pressed for toggles and aria-checked radios for the format switch', () => {
    expect(toggleSemantics(true)).toEqual({ role: 'button', 'aria-pressed': true });
    expect(radioSemantics(false)).toEqual({ role: 'radio', 'aria-checked': false });
    expect(radioGroupSemantics('Format of this explanation')).toEqual({
      role: 'radiogroup',
      'aria-label': 'Format of this explanation',
    });
  });

  it('puts the dialog name on the Modal only, never a second aria-modal inside it', () => {
    expect(dialogSemantics('Share')).toEqual({});
    expect(dialogHostSemantics('Share')).toEqual({ 'aria-label': 'Share' });
  });

  it('describes unread through aria-describedby pointing at a hidden element', () => {
    expect(describedByElement).toBe(true);
    expect(descriptionSemantics('Unread messages', 'ks-unread-1')).toEqual({ 'aria-describedby': 'ks-unread-1' });
    expect(descriptionSemantics(undefined, 'ks-unread-1')).toEqual({});
  });
});

describe('useFocusRing (web)', () => {
  it('draws the ring with :focus-visible only, cobalt on light and yellow on dark, installed once', () => {
    expect(useFocusRing('onLight').props).toMatchObject({ dataSet: { ksFocus: 'onLight' } });
    useFocusRing('onDark');
    const sheets = document.querySelectorAll('style#ks-focus-ring');
    expect(sheets).toHaveLength(1);
    const css = sheets[0]?.textContent ?? '';
    expect(css).toContain('[data-ks-focus="onLight"]:focus-visible{outline:3px solid #2C46E8;outline-offset:3px}');
    expect(css).toContain('[data-ks-focus="onDark"]:focus-visible{outline:3px solid #FFE44D;outline-offset:3px}');
    expect(css).toContain('[data-ks-focus]:focus{outline:none}');
  });
});
