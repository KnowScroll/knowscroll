import { configure, fireEvent, screen } from '@testing-library/react-native';
import { ScrollArticle } from './article';
import { bridgesPoster, lighthouseEditorial } from './fixtures/documents';
import { sequenceBlock } from './fixtures/blocks';
import { createMemoryBlockStateStore } from './state';
import { articleOf, ready, show } from '../test-support/scroll';

/** The article's text version switch, and what a changed revision does to a block's state. */

beforeAll(() => {
  configure({ defaultIncludeHiddenElements: true });
});

afterAll(() => {
  configure({ defaultIncludeHiddenElements: false });
});

const diagramImages = () =>
  screen.queryAllByLabelText('Diagram: where the load goes').filter((node) => node.props.accessibilityRole === 'image');

describe('the text version of diagrams', () => {
  it('is a real switch, off at first, that turns every visual block into its words and back', async () => {
    await show(<ScrollArticle document={ready(bridgesPoster())} />);
    const toggle = () => screen.getByRole('switch', { name: 'Text version of diagrams' });
    expect(toggle()).not.toBeChecked();
    expect(diagramImages()).toHaveLength(1);
    expect(screen.queryByText('Deck → Cables')).toBeNull();

    await fireEvent.press(toggle());

    expect(toggle()).toBeChecked();
    expect(diagramImages()).toHaveLength(0);
    expect(screen.getByText('Deck → Cables')).toBeOnTheScreen();
    // The chart shows its table, with no toggle of its own.
    expect(screen.getByText('Strength (of 10)')).toBeOnTheScreen();

    await fireEvent.press(toggle());

    expect(toggle()).not.toBeChecked();
    expect(diagramImages()).toHaveLength(1);
  });

  it('is offered only where the article has something visual to describe', async () => {
    await show(<ScrollArticle document={ready(lighthouseEditorial())} />);
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('when the revision of an article changes', () => {
  const rev2 = { assetId: 'fixture-one', revision: 2, blockId: 'seq-size' };

  async function readOnStep3(store: ReturnType<typeof createMemoryBlockStateStore>) {
    const first = await show(<ScrollArticle document={articleOf([sequenceBlock('seq-size')], 1)} store={store} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Step 3 of 4')).toBeOnTheScreen();
    await first.unmount();
  }

  it('starts a stateful block over and says so, until the reader acts on it or dismisses the notice', async () => {
    const store = createMemoryBlockStateStore();
    await readOnStep3(store);

    await show(<ScrollArticle document={articleOf([sequenceBlock('seq-size')], 2)} store={store} />);

    expect(screen.getByText('Step 1 of 4')).toBeOnTheScreen();
    expect(screen.getByText('Updated.')).toBeOnTheScreen();
    expect(store.get(rev2)).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText('Updated.')).toBeNull();
  });

  it('keeps the state of a block the package declares unchanged (a compatible migration), with no notice', async () => {
    const store = createMemoryBlockStateStore();
    await readOnStep3(store);

    await show(
      <ScrollArticle
        document={articleOf([sequenceBlock('seq-size')], 2)}
        store={store}
        carryOverBlockIds={new Set(['seq-size'])}
      />,
    );

    expect(screen.getByText('Step 3 of 4')).toBeOnTheScreen();
    expect(screen.queryByText('Updated.')).toBeNull();
    expect(store.get(rev2)).toEqual({ type: 'sequence', step: 'st-loads' });
  });

  it('says nothing when there was nothing of the reader’s to lose', async () => {
    const store = createMemoryBlockStateStore();

    await show(<ScrollArticle document={articleOf([sequenceBlock('seq-size')], 2)} store={store} />);

    expect(screen.getByText('Step 1 of 4')).toBeOnTheScreen();
    expect(screen.queryByText('Updated.')).toBeNull();
  });
});
