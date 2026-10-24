import { render, screen } from '@testing-library/react-native';
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import type { EvidencePanel as EvidencePanelComponent } from './evidence-panel';

const scope = createAccountScope({
  account: {
    accountId: '0199a000-0000-7000-8000-00000000000a',
    universeId: '0199a000-0000-7000-8000-0000000000aa',
    privacyEpoch: 1,
    email: 'a@panel.test',
  },
  baseUrl: 'https://app.panel.test',
  fetch: () => Promise.reject(new Error('The panel must not ask for anything')),
  authorization: () => undefined,
  store: memoryStore(),
});

function mountFresh(): React.ReactElement {
  // The condition is read once, when the module loads, as in a bundle.
  let element: React.ReactElement | undefined;
  jest.isolateModules(() => {
    const { EvidencePanel } = jest.requireActual<{ EvidencePanel: typeof EvidencePanelComponent }>('./evidence-panel');
    element = (
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <EvidencePanel scope={scope} exposureId="0199a000-0000-7000-8000-0000000000e1" />
      </DisplayProvider>
    );
  });
  return element!;
}

describe('the dev evidence panel switch', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_KS_DEV_EVIDENCE;
  });

  it('is off by default: nothing is drawn and nothing is asked, even in a world with operator tools', async () => {
    delete process.env.EXPO_PUBLIC_KS_DEV_EVIDENCE;
    await render(mountFresh());
    expect(screen.queryByTestId('ks-dev-evidence')).toBeNull();
  });
});
