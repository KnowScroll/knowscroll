import { fireEvent, render, screen } from '@testing-library/react-native';
import sortFork from '@knowscroll/scroll-model/fixtures/sort-fork-blocks-ci.json';
import scaleChart from '@knowscroll/scroll-model/fixtures/scale-chart-blocks-ci.json';
import type { Guide, Interactive, ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { DisplayProvider } from '../../display/display';
import { StageReader } from '../stage-reader/stage-reader';
import type { StageReadingObserver } from '../stage-reader/use-stop-reading';
import { GuideView, PlayBlockView } from '.';
import { openingZoom, scaleView, zoomStops } from './scale-geometry';
import { moved, shownOrder } from './sort-state';

/**
 * The play blocks of D-207 over the labelled CI fixtures (`*-blocks-ci`, not product content): what each
 * draws and does on the device, its text version, and that playing one reports nothing to the recorder.
 * The browser behaviour and axe are in `apps/client/e2e/blocks-smoke.spec.ts`.
 */
const withBlocks = (document: unknown): readonly ScrollDocumentV2['stops'][number][] =>
  (document as ScrollDocumentV2).stops;
const blockOf = (document: unknown, type: Interactive['type']): Interactive => {
  for (const stop of withBlocks(document))
    if (stop.kind === 'read' && stop.interactive?.type === type) return stop.interactive;
  throw new Error(`no ${type} in the fixtures`);
};
const sort = blockOf(sortFork, 'sort');
const fork = blockOf(sortFork, 'fork');
const scale = blockOf(scaleChart, 'scale');
const chart = blockOf(scaleChart, 'chart');

const show = (interactive: Interactive, readerAsText = false) =>
  render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <PlayBlockView interactive={interactive} readerAsText={readerAsText} />
    </DisplayProvider>,
  );

describe('a sort', () => {
  it('shows the items shuffled with arrow buttons, and moves one by one', async () => {
    await show(sort);
    expect(screen.getAllByTestId('sort-row')).toHaveLength(4);
    // The first card can only go down, the last only up.
    expect(screen.getByRole('button', { name: /^Move "The northern half warms" up/ })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: /^Move "The northern half warms" down/ }));
    expect(screen.getByText(/The northern half warms is now number 2 of 4/)).toBeOnTheScreen();
  });

  it('says how many are in the right place after a wrong check, then shows the order and why', async () => {
    await show(sort);
    await fireEvent.press(screen.getByRole('button', { name: 'Check order' }));
    expect(screen.getByTestId('sort-close')).toBeOnTheScreen();
    expect(screen.queryByTestId('sort-right')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Show the order' }));
    const answer = screen.getAllByTestId('sort-answer');
    expect(answer).toHaveLength(4);
    expect(screen.getByTestId('sort-explain')).toBeOnTheScreen();
  });

  it('is right when the cards are put in the document’s order, and only then', async () => {
    await show(sort);
    // The fixture shows the items as [warms, steeply, lean, long]; the order is lean, steeply, long, warms.
    const press = async (name: RegExp) => fireEvent.press(screen.getByRole('button', { name }));
    await press(/^Move "The lean points toward Vael" up/);
    await press(/^Move "The lean points toward Vael" up/);
    await press(/^Move "The northern half warms" down/);
    await press(/^Move "The northern half warms" down/);
    await fireEvent.press(screen.getByRole('button', { name: 'Check order' }));
    expect(screen.getByTestId('sort-right')).toBeOnTheScreen();
  });

  it('is a list of the items with a way to see the order in the text version', async () => {
    await show(sort, true);
    expect(screen.queryByRole('button', { name: 'Check order' })).not.toBeOnTheScreen();
    expect(screen.queryByTestId('sort-answer')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Show the order' }));
    expect(screen.getAllByTestId('sort-answer')).toHaveLength(4);
  });

  it('moves nothing past either end', () => {
    expect(moved(shownOrder(3), 0, -1)).toEqual([0, 1, 2]);
    expect(moved(shownOrder(3), 2, 1)).toEqual([0, 1, 2]);
    expect(moved(shownOrder(3), 0, 1)).toEqual([1, 0, 2]);
  });
});

describe('a fork', () => {
  it('shows two paths, reads the one picked and keeps the other available', async () => {
    await show(fork);
    expect(screen.queryByTestId('fork-branch')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Path: The north' }));
    expect(screen.getByText(/The north warms while its lean points toward Vael/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Path: The south' }));
    expect(screen.getByText(/The south cools in those same months/)).toBeOnTheScreen();
    expect(screen.queryByText(/The north warms while/)).not.toBeOnTheScreen();
  });

  it('shows both paths in the text version without a choice', async () => {
    await show(fork, true);
    expect(screen.getByText(/The north: The north warms/)).toBeOnTheScreen();
    expect(screen.getByText(/The south: The south cools/)).toBeOnTheScreen();
  });
});

describe('a scale', () => {
  it('draws one picture named by its words, and zooms out by chips', async () => {
    await show(scale);
    expect(screen.getByLabelText(/logarithmic scale in million km/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Zoom out to Pell' })).toHaveProp('aria-pressed', true);
    await fireEvent.press(screen.getByRole('button', { name: 'Zoom out to Sarn' }));
    expect(screen.getByRole('button', { name: 'Zoom out to Sarn' })).toHaveProp('aria-pressed', true);
  });

  it('opens on the nearest view that holds "you are here", and each chip is a wider view', () => {
    if (scale.type !== 'scale') throw new Error('a scale');
    expect(zoomStops(scale).map((stop) => [stop.label, stop.shown])).toEqual([
      ['Pell', 2],
      ['Sarn', 3],
    ]);
    expect(openingZoom(scale)).toBe(0);
    expect(openingZoom({ ...scale, here: 2 })).toBe(1);
    const near = scaleView(scale, 2);
    const wide = scaleView(scale, 3);
    expect(near.points.map((point) => point.label)).toEqual(['Orrin', 'Pell']);
    // A wider view puts the same point nearer the start of the line.
    expect(wide.axis.at(310)).toBeLessThan(near.axis.at(310));
    expect(wide.axis.domain[1]).toBeGreaterThan(near.axis.domain[1]);
  });

  it('lists the points from smallest to largest in the text version', async () => {
    await show(scale, true);
    expect(screen.getByTestId('scale-text')).toHaveTextContent(
      /Orrin: 120 million km; Pell: 310 million km; Sarn: 1,200 million km.*You are here: Orrin/,
    );
  });
});

describe('a growing chart', () => {
  it('starts with one point and reveals the next on request, then starts again', async () => {
    await show(chart);
    expect(screen.getByTestId('chart-readout')).toHaveTextContent('10 crates: 100 trips');
    await fireEvent.press(screen.getByRole('button', { name: 'Show the next point' }));
    expect(screen.getByTestId('chart-readout')).toHaveTextContent('100 crates: 10,000 trips');
    await fireEvent.press(screen.getByRole('button', { name: 'Show the next point' }));
    expect(screen.getByTestId('chart-readout')).toHaveTextContent('1,000 crates: 1,000,000 trips');
    expect(screen.queryByRole('button', { name: 'Show the next point' })).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Start again' }));
    expect(screen.getByTestId('chart-readout')).toHaveTextContent('10 crates: 100 trips');
  });

  it('is the whole list of points in the text version', async () => {
    await show(chart, true);
    expect(screen.getByTestId('chart-text')).toHaveTextContent(
      /10 crates: 100 trips; 100 crates: 10,000 trips; 1,000 crates: 1,000,000 trips/,
    );
  });
});

describe('a guide', () => {
  const guide: Guide = { character: 'ray', pose: 'wonder', line: 'Same sunshine, more ground.' };

  it('speaks in a bubble beside Ray, and is a plain line with the name in the text version', async () => {
    const view = await render(<GuideView guide={guide} asText={false} />);
    expect(screen.getByLabelText('Ray says: Same sunshine, more ground.')).toBeOnTheScreen();
    await view.rerender(<GuideView guide={guide} asText />);
    expect(screen.getByTestId('guide-text')).toHaveTextContent('Ray: Same sunshine, more ground.');
  });
});

describe('the text version', () => {
  it('follows the reader’s switch for every block, and a block’s own switch overrides it for that block', async () => {
    await show(chart, true);
    expect(screen.getByTestId('chart-text')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Text version of the chart' }));
    expect(screen.queryByTestId('chart-text')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Show the next point' })).toBeOnTheScreen();
  });
});

type Spy = { [Method in keyof StageReadingObserver]: jest.Mock<void, Parameters<StageReadingObserver[Method]>> };

describe('playing a block in the reader', () => {
  it('reports nothing about the play: no interaction, whatever is sorted, chosen, zoomed or revealed', async () => {
    const observer: Spy = {
      onBlockVisibility: jest.fn<void, Parameters<StageReadingObserver['onBlockVisibility']>>(),
      onBlockInteraction: jest.fn<void, Parameters<StageReadingObserver['onBlockInteraction']>>(),
      onActivity: jest.fn<void, Parameters<StageReadingObserver['onActivity']>>(),
    };
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <StageReader document={sortFork as unknown as ScrollDocumentV2} observer={observer} commands={{}} />
      </DisplayProvider>,
    );
    await fireEvent.press(screen.getAllByRole('button', { name: /^Move ".*" down/ })[0] as never);
    await fireEvent.press(screen.getByRole('button', { name: 'Check order' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Path: The north' }));
    expect(screen.getByText(/The north warms while/)).toBeOnTheScreen();
    expect(observer.onBlockInteraction).not.toHaveBeenCalled();
  });
});
