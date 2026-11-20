import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import seasonsV3 from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import seasonsV2 from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2, ScrollDocumentV3 } from '@knowscroll/scroll-model';
import type { OpenedScrollFolio } from './scroll-session';
import { useQuickAnswers } from './use-quick-answers';

const mockScope = { active: true };
// One snapshot object, as the real session keeps one: a store that returned a new one every read would loop.
const mockSnapshot = { cards: {} };
const mockSessionFor = jest.fn((_input: unknown) => ({
  subscribe: () => () => undefined,
  getSnapshot: () => mockSnapshot,
  ask: jest.fn(),
  dismiss: jest.fn(),
}));
jest.mock('@knowscroll/client-core', () => ({
  ...jest.requireActual<object>('@knowscroll/client-core'),
  quickAnswerSessionFor: (input: unknown) => mockSessionFor(input),
}));
let mockSignedIn = true;
jest.mock('../../providers/account-scope', () => ({
  useAccountScopeIfPresent: () => ({
    state: mockSignedIn ? { status: 'signed_in', scope: mockScope } : { status: 'signed_out' },
  }),
}));
jest.mock('../../platform/command-id', () => ({ newCommandId: () => 'command' }));

const open = (document: ScrollDocumentV2 | ScrollDocumentV3) =>
  ({ assetId: 'asset-7', assetRevision: 3, document }) as unknown as OpenedScrollFolio;

function Probe({ scroll }: { readonly scroll: OpenedScrollFolio }) {
  const quick = useQuickAnswers(scroll);
  return <Text testID="has-quick-answers">{quick === undefined ? 'no' : 'yes'}</Text>;
}

beforeEach(() => {
  mockSignedIn = true;
  mockSessionFor.mockClear();
});

describe('Quick answers on a Folio Scroll (use-quick-answers.ts)', () => {
  it('offers them on a v3 Scroll, whose beats are the places an answer is asked at', async () => {
    await render(<Probe scroll={open(seasonsV3 as unknown as ScrollDocumentV3)} />);
    expect(screen.getByTestId('has-quick-answers')).toHaveTextContent('yes');
    expect(mockSessionFor).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'asset-7', revision: 3 }));
  });

  it('offers them on a v2 Scroll as before', async () => {
    await render(<Probe scroll={open(seasonsV2 as unknown as ScrollDocumentV2)} />);
    expect(screen.getByTestId('has-quick-answers')).toHaveTextContent('yes');
  });

  it('offers none to a person who is not signed in', async () => {
    mockSignedIn = false;
    await render(<Probe scroll={open(seasonsV3 as unknown as ScrollDocumentV3)} />);
    expect(screen.getByTestId('has-quick-answers')).toHaveTextContent('no');
    expect(mockSessionFor).not.toHaveBeenCalled();
  });
});
