import type * as React from 'react';
import { act, render } from '@testing-library/react-native';
import { useFocusEffect } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { DisplayProvider } from '@knowscroll/ui';
import { GalleryScreen } from './gallery-screen';
import { ScrollGalleryScreen } from './scroll-gallery-screen';

jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
jest.mock('expo-router', () => ({
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ setParams: jest.fn() }),
}));
jest.mock('../diagnostics/health-panel', () => ({ HealthPanel: () => null }));

// Focus is a labelled router stand-in. Native system pixels remain a hosted emulator/device gate.
it.each([
  ['components', GalleryScreen],
  ['Scroll', ScrollGalleryScreen],
] as const)(
  'the cream %s gallery takes dark status icons on every focus, without changing the global theme',
  async (_name, Gallery: React.ComponentType) => {
    jest.mocked(useFocusEffect).mockClear();
    jest.mocked(setStatusBarStyle).mockClear();
    const app = await render(
      <DisplayProvider value={{ width: 355, reducedMotion: true }}>
        <Gallery />
      </DisplayProvider>,
    );
    const focus = jest.mocked(useFocusEffect).mock.calls.at(-1)![0];
    // A previously focused space route owns light icons. Gallery mount alone does not override it.
    setStatusBarStyle('light');
    await act(() => {
      focus();
    });
    expect(setStatusBarStyle).toHaveBeenLastCalledWith('dark');
    setStatusBarStyle('light');
    await act(() => {
      focus();
    });
    expect(setStatusBarStyle).toHaveBeenLastCalledWith('dark');
    await app.unmount();
  },
);
