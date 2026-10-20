import { act, configure, fireEvent, screen, within } from '@testing-library/react-native';
import { ScrollArticle } from '../article';
import {
  cycleDiagram,
  gridDiagram,
  layersDiagram,
  loadPathDiagram,
  sequenceBlock,
  weightDiagram,
} from '../fixtures/blocks';
import { HORIZONTAL_PAN, TWO_AXIS_PAN } from '../gestures/arbitration';
import { createMemoryBlockStateStore } from '../state';
import { anyNumber, articleOf, observerDouble, show } from '../../test-support/scroll';
import { lastPan, panConfigs } from '../../test-support/gesture-handler.mock';
import { layoutDiagram } from './diagram/layout';
import { expectPressed } from '../../test-support/render';

/** The stepper and the diagram, with their state, interactions, text versions and the drag. */

beforeAll(() => {
  configure({ defaultIncludeHiddenElements: true });
});

afterAll(() => {
  configure({ defaultIncludeHiddenElements: false });
});

const seqKey = { assetId: 'fixture-one', revision: 1, blockId: 'seq-size' };

describe('a stepper', () => {
  it('shows one step at a time with its position in words, and Previous is off at the start', async () => {
    await show(<ScrollArticle document={articleOf([sequenceBlock('seq-size')])} />);

    expect(screen.getByText('Step 1 of 4')).toBeOnTheScreen();
    expect(screen.getByText('Measure the gap')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByText('Sizing a bridge')).toBeOnTheScreen();
  });

  it('moves with Next and Previous, keeps the step by (revision, block), reports each step, and stops at the ends', async () => {
    const store = createMemoryBlockStateStore();
    const watcher = observerDouble();
    await show(<ScrollArticle document={articleOf([sequenceBlock('seq-size')])} store={store} observer={watcher} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Step 2 of 4')).toBeOnTheScreen();
    expect(screen.getByText('Choose the shape')).toBeOnTheScreen();
    expect(store.get(seqKey)).toEqual({ type: 'sequence', step: 'st-shape' });
    expect(watcher.onBlockInteraction).toHaveBeenCalledWith({ blockId: 'seq-size', kind: 'step', at: anyNumber });

    await fireEvent.press(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByText('Step 1 of 4')).toBeOnTheScreen();

    for (let step = 0; step < 3; step += 1) await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Step 4 of 4')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('shows the step’s figure (a placeholder with its alt text) and gives the article back its step on return', async () => {
    const store = createMemoryBlockStateStore();
    const document = articleOf([sequenceBlock('seq-size')]);
    const first = await show(<ScrollArticle document={document} store={store} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    expect(
      screen.getByText('Arrows pressing down on a deck from above and a smaller arrow pushing sideways.'),
    ).toBeOnTheScreen();
    await first.unmount();

    await show(<ScrollArticle document={document} store={store} />);
    expect(screen.getByText('Step 3 of 4')).toBeOnTheScreen();
  });

  it('starts over with Reset, and says nothing of it to the observer but a control', async () => {
    const store = createMemoryBlockStateStore();
    const watcher = observerDouble();
    await show(<ScrollArticle document={articleOf([sequenceBlock('seq-size')])} store={store} observer={watcher} />);
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Reset' }));

    expect(screen.getByText('Step 1 of 4')).toBeOnTheScreen();
    expect(store.get(seqKey)).toBeNull();
    expect(watcher.onBlockInteraction).toHaveBeenLastCalledWith({
      blockId: 'seq-size',
      kind: 'control',
      at: anyNumber,
    });
  });

  it('lists every step in its text version, with no Previous or Next', async () => {
    await show(<ScrollArticle document={articleOf([sequenceBlock('seq-size')])} initialTextVersion />);

    expect(screen.getByText(/1\. Measure the gap\./)).toBeOnTheScreen();
    expect(screen.getByText(/4\. Check the margin\./)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });
});

function frameText(id: string) {
  return within(screen.getByTestId(`block-${id}`));
}

describe('a stepped diagram', () => {
  const key = { assetId: 'fixture-one', revision: 1, blockId: 'diagram-load' };

  it('names its frame and says what it shows, and steps through its frames with Previous and Next', async () => {
    const store = createMemoryBlockStateStore();
    const watcher = observerDouble();
    await show(
      <ScrollArticle document={articleOf([loadPathDiagram('diagram-load')])} store={store} observer={watcher} />,
    );
    const block = frameText('diagram-load');

    expect(block.getByText(/Traffic and the deck itself press down/)).toBeOnTheScreen();
    expect(block.getByText('Step 1 of 3')).toBeOnTheScreen();
    expect(block.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(block.getByRole('button', { name: 'Reset' })).toBeDisabled();

    await fireEvent.press(block.getByRole('button', { name: 'Next' }));

    expect(block.getByText(/The cables pull on the towers/)).toBeOnTheScreen();
    expect(block.getByText('Step 2 of 3')).toBeOnTheScreen();
    expect(store.get(key)).toEqual({ type: 'diagram', frame: 'f-towers' });
    expect(watcher.onBlockInteraction).toHaveBeenCalledWith({ blockId: 'diagram-load', kind: 'step', at: anyNumber });
    expect(block.getByRole('button', { name: 'Reset' })).toBeEnabled();

    await fireEvent.press(block.getByRole('button', { name: 'Reset' }));
    expect(block.getByText(/Traffic and the deck itself press down/)).toBeOnTheScreen();
    expect(store.get(key)).toBeNull();
  });

  it('is an image for assistive technology, named by the block and described, and captures no gesture', async () => {
    await show(<ScrollArticle document={articleOf([loadPathDiagram('diagram-load')])} />);

    const images = screen
      .getAllByLabelText('Diagram: where the load goes')
      .filter((node) => node.props.accessibilityRole === 'image');
    expect(images).toHaveLength(1);
    expect(loadPathDiagram('x').gesture).toBe('none');
  });

  it('gives the diagram in words on "Describe this diagram" (the nodes and how they are joined), and takes it back', async () => {
    const watcher = observerDouble();
    await show(<ScrollArticle document={articleOf([loadPathDiagram('diagram-load')])} observer={watcher} />);
    const block = frameText('diagram-load');
    expect(block.queryByText('Deck → Cables')).toBeNull();

    await fireEvent.press(block.getByRole('togglebutton', { name: 'Describe this diagram' }));

    expect(block.getByText('In the diagram: Deck, Cables, Towers, Ground.')).toBeOnTheScreen();
    expect(block.getByText('Deck → Cables')).toBeOnTheScreen();
    expect(block.getByText('Towers → Ground')).toBeOnTheScreen();
    expect(watcher.onBlockInteraction).toHaveBeenCalledWith({
      blockId: 'diagram-load',
      kind: 'text_version',
      at: anyNumber,
    });

    await fireEvent.press(block.getByRole('togglebutton', { name: 'Hide description' }));
    expect(block.queryByText('Deck → Cables')).toBeNull();
  });

  it('is only text under the article’s text version, with its controls still working', async () => {
    await show(<ScrollArticle document={articleOf([loadPathDiagram('diagram-load')])} initialTextVersion />);
    const block = frameText('diagram-load');

    expect(block.getByText('Deck → Cables')).toBeOnTheScreen();
    expect(
      screen
        .queryAllByLabelText('Diagram: where the load goes')
        .filter((node) => node.props.accessibilityRole === 'image'),
    ).toHaveLength(0);
    expect(block.queryByRole('togglebutton', { name: 'Describe this diagram' })).toBeNull();
    await fireEvent.press(block.getByRole('button', { name: 'Next' }));
    expect(block.getByText(/The cables pull on the towers/)).toBeOnTheScreen();
  });
});

describe('a diagram with a button per frame', () => {
  it('has exactly one frame current, announced as pressed, and a press chooses another', async () => {
    const watcher = observerDouble();
    await show(<ScrollArticle document={articleOf([cycleDiagram('diagram-cycle')])} observer={watcher} />);
    const block = frameText('diagram-cycle');

    expectPressed(block.getByRole('togglebutton', { name: 'Plan' }), true);
    expectPressed(block.getByRole('togglebutton', { name: 'Build' }), false);
    expect(block.getByText(/Loads are added up and a shape is chosen/)).toBeOnTheScreen();

    await fireEvent.press(block.getByRole('togglebutton', { name: 'Build' }));

    expectPressed(block.getByRole('togglebutton', { name: 'Build' }), true);
    expectPressed(block.getByRole('togglebutton', { name: 'Plan' }), false);
    expect(block.getByText(/Parts are made and put in place/)).toBeOnTheScreen();
    expect(watcher.onBlockInteraction).toHaveBeenCalledWith({ blockId: 'diagram-cycle', kind: 'step', at: anyNumber });
  });
});

describe('a static diagram', () => {
  it('has no frames, no Reset and no controls, and gives its own description on request', async () => {
    await show(<ScrollArticle document={articleOf([layersDiagram('diagram-layers'), gridDiagram('diagram-grid')])} />);
    const layers = frameText('diagram-layers');

    expect(layers.queryByRole('button', { name: 'Reset' })).toBeNull();
    expect(layers.queryByRole('button', { name: 'Next' })).toBeNull();
    await fireEvent.press(layers.getByRole('togglebutton', { name: 'Describe this diagram' }));
    expect(layers.getByText('In the diagram: Deck, Towers, Foundation, Soil.')).toBeOnTheScreen();
    expect(layers.getByText('Foundation → Soil')).toBeOnTheScreen();
  });
});

describe('a diagram that drags', () => {
  const block = () => weightDiagram('diagram-weight');
  const layout = layoutDiagram(block().data);
  const token = layout.nodes.find((node) => node.id === 'load');
  const left = layout.nodes.find((node) => node.id === 'left');
  if (token === undefined || left === undefined) throw new Error('the fixture has a token and a left pier');
  const event = (translationX: number, translationY: number) => ({ x: 0, y: 0, translationX, translationY });

  beforeEach(() => {
    panConfigs.length = 0;
  });

  it('captures both axes from the first movement and says so: the block owns the drag until release', async () => {
    await show(<ScrollArticle document={articleOf([block()])} />);
    const pan = lastPan();

    expect(pan.enabled).toBe(true);
    expect(pan.runOnJS).toBe(true);
    expect(pan.minDistance).toBe(TWO_AXIS_PAN.minDistance);
    // A two-axis capture has no sideways-only rule: it is not the slider's pan.
    expect(pan.activeOffsetX).toBeUndefined();
    expect(pan.failOffsetY).toBeUndefined();
    expect(HORIZONTAL_PAN.activeOffsetX).toBeDefined();
    expect(block().gesture).toBe('two-axis');
  });

  it('chooses the frame of the target the token is dropped on, and reports a drag', async () => {
    const watcher = observerDouble();
    const store = createMemoryBlockStateStore();
    await show(<ScrollArticle document={articleOf([block()])} observer={watcher} store={store} />);
    const view = frameText('diagram-weight');
    expect(view.getByText(/With the weight over the middle/)).toBeOnTheScreen();

    await act(() => {
      lastPan().onActivate?.(event(0, 0));
      lastPan().onUpdate?.(event(left.x - token.x, left.y - token.y));
    });
    await act(() => {
      lastPan().onDeactivate?.(event(left.x - token.x, left.y - token.y));
      lastPan().onFinalize?.(event(left.x - token.x, left.y - token.y));
    });

    expect(view.getByText(/With the weight over the left pier/)).toBeOnTheScreen();
    expect(store.get({ assetId: 'fixture-one', revision: 1, blockId: 'diagram-weight' })).toEqual({
      type: 'diagram',
      frame: 'f-left',
    });
    expect(watcher.onBlockInteraction).toHaveBeenCalledWith({ blockId: 'diagram-weight', kind: 'drag', at: anyNumber });
  });

  it('changes nothing when the token is dropped anywhere else', async () => {
    const watcher = observerDouble();
    await show(<ScrollArticle document={articleOf([block()])} observer={watcher} />);
    const view = frameText('diagram-weight');

    await act(() => {
      lastPan().onActivate?.(event(0, 0));
      lastPan().onUpdate?.(event(3, 4));
    });
    await act(() => {
      lastPan().onDeactivate?.(event(3, 4));
      lastPan().onFinalize?.(event(3, 4));
    });

    expect(view.getByText(/With the weight over the middle/)).toBeOnTheScreen();
    expect(watcher.onBlockInteraction).not.toHaveBeenCalled();
  });

  it('gives a keyboard or a screen reader the same choice as a list of targets', async () => {
    const watcher = observerDouble();
    await show(<ScrollArticle document={articleOf([block()])} observer={watcher} />);
    const view = frameText('diagram-weight');
    expectPressed(view.getByRole('togglebutton', { name: 'Toward Middle' }), true);

    await fireEvent.press(view.getByRole('togglebutton', { name: 'Toward Right pier' }));

    expect(view.getByText(/With the weight over the right pier/)).toBeOnTheScreen();
    expectPressed(view.getByRole('togglebutton', { name: 'Toward Right pier' }), true);
    expect(watcher.onBlockInteraction).toHaveBeenCalledWith({
      blockId: 'diagram-weight',
      kind: 'control',
      at: anyNumber,
    });
  });

  it('returns to its first frame on Reset, and marks no part of it as the only way in', async () => {
    await show(<ScrollArticle document={articleOf([block()])} />);
    const view = frameText('diagram-weight');
    await fireEvent.press(view.getByRole('togglebutton', { name: 'Toward Left pier' }));
    expect(view.getByRole('button', { name: 'Reset' })).toBeEnabled();

    await fireEvent.press(view.getByRole('button', { name: 'Reset' }));

    expect(view.getByText(/With the weight over the middle/)).toBeOnTheScreen();
    expect(view.getByText('Drag the weight toward a support')).toBeOnTheScreen();
  });
});
