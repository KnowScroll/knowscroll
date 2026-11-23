import { fireEvent, render, screen } from '@testing-library/react-native';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import seasonsV3 from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import {
  coverFrameOfV3,
  describePicture,
  type ScrollDocumentV2,
  type ScrollDocumentV3,
} from '@knowscroll/scroll-model';
import { DisplayProvider } from '../../display/display';
import { drawableStage, stageFigureAt } from '../stage/stage-figure';
import { EssayCover, type EssayCoverProps } from './essay-cover';
import { pictureFigureOf } from './from-v3';

// The labelled CI fixture of `scroll-model` (not product content): its first stage state is the cover's figure.
const document = seasons as unknown as ScrollDocumentV2;
const stage = drawableStage(document.stage);
const first = stage?.states[0];
if (stage === undefined || first === undefined) throw new Error('the fixture has a stage');
const figure = stageFigureAt(stage, document.stops, first.stop);

// The labelled document v3 fixture: the cover's picture is the first one its beats show, as the server picks it.
const frameOfV3 = coverFrameOfV3(seasonsV3 as unknown as ScrollDocumentV3);
if (frameOfV3 === undefined) throw new Error('the fixture shows a picture');
const pictureFigure = pictureFigureOf(frameOfV3.picture, frameOfV3.state);

async function cover(overrides: Partial<EssayCoverProps> = {}) {
  const props: EssayCoverProps = {
    kicker: 'CI cover fixture',
    title: 'Why the fixture has seasons',
    dek: 'A tilted planet, in a few steps.',
    minutes: 3.4,
    figure,
    way: 'read',
    position: { index: 2, count: 3 },
    next: { kicker: 'Next fixture', title: 'How tides work' },
    onOpen: jest.fn(),
    onNext: jest.fn(),
    onPrevious: jest.fn(),
    reducedMotion: true,
    height: 760,
    ...overrides,
  };
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <EssayCover {...props} />
    </DisplayProvider>,
  );
  return { props };
}

describe('a Scroll as a cover', () => {
  it('shows the opening, the position and the reading time, with the title as the one heading', async () => {
    await cover();
    expect(screen.getByRole('header', { name: 'Why the fixture has seasons' })).toBeOnTheScreen();
    expect(screen.getByText('CI cover fixture')).toBeOnTheScreen();
    expect(screen.getByText('A tilted planet, in a few steps.')).toBeOnTheScreen();
    expect(screen.getByText('2 OF 3')).toBeOnTheScreen();
    expect(screen.getByText('3 MIN')).toBeOnTheScreen();
  });

  it('shows a reading time of at least a minute', async () => {
    await cover({ minutes: 0.2 });
    expect(screen.getByText('1 MIN')).toBeOnTheScreen();
  });

  it('opens with a Read button named for the Scroll, or Continue after a part read', async () => {
    const { props } = await cover();
    await fireEvent.press(screen.getByRole('button', { name: 'Read Why the fixture has seasons' }));
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    await screen.unmount();
    await cover({ way: 'continue' });
    expect(screen.getByRole('button', { name: 'Continue Why the fixture has seasons' })).toBeOnTheScreen();
    expect(screen.getByText('Continue')).toBeOnTheScreen();
  });

  it('goes to the next and the previous cover from the arrows, and to the next from the strip', async () => {
    const { props } = await cover();
    await fireEvent.press(screen.getByRole('button', { name: 'Previous cover' }));
    expect(props.onPrevious).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Next cover' }));
    expect(props.onNext).toHaveBeenCalledTimes(1);
    expect(screen.getByText('NEXT · Next fixture')).toBeOnTheScreen();
    expect(screen.getByText('How tides work')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('essay-cover-next'));
    expect(props.onNext).toHaveBeenCalledTimes(2);
  });

  it('keeps Previous on the first cover, disabled, so focus is not dropped there', async () => {
    const { props } = await cover({ onPrevious: undefined, position: { index: 1, count: 3 } });
    const previous = screen.getByRole('button', { name: 'Previous cover' });
    expect(previous).toBeDisabled();
    await fireEvent.press(previous);
    expect(props.onNext).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Next cover' })).toBeOnTheScreen();
  });

  it('says MORE COVERS where the hand ends', async () => {
    const { props } = await cover({ next: 'more', position: { index: 3, count: 3 } });
    expect(screen.getByText('MORE COVERS')).toBeOnTheScreen();
    expect(screen.queryByText(/^NEXT · /)).toBeNull();
    await fireEvent.press(screen.getByTestId('essay-cover-next'));
    expect(props.onNext).toHaveBeenCalledTimes(1);
  });

  it('draws the figure on a plate that cannot be operated: no Text chip, no control', async () => {
    await cover();
    expect(screen.getByTestId('essay-cover-figure')).toBeOnTheScreen();
    expect(screen.queryByText('Text')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Text version of this picture' })).toBeNull();
    expect(screen.queryByRole('adjustable')).toBeNull();
  });

  it('draws no plate for a cover without a figure', async () => {
    await cover({ figure: undefined });
    expect(screen.queryByTestId('essay-cover-figure')).toBeNull();
    expect(screen.getByRole('button', { name: /^Read / })).toBeOnTheScreen();
  });

  it('opens from a tap on the opening, which is not a control of its own', async () => {
    const { props } = await cover();
    await fireEvent.press(screen.getByText('A tilted planet, in a few steps.'));
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    // Read is the one button for opening: the opening's own area adds none.
    expect(screen.getAllByRole('button', { name: /Read|Continue|open/i })).toHaveLength(1);
  });

  it('keeps the figure where the text leaves room for it and drops it where it does not', async () => {
    const laid = (testID: string, height: number) =>
      fireEvent(screen.getByTestId(testID), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 350, height } } });
    // The opening, buttons and strip measure 400 + 70 px with no figure: 844 px leaves 300 for one, 568 px nothing.
    await cover({ height: 844 });
    await laid('essay-cover-body', 400);
    await laid('essay-cover-next', 70);
    expect(screen.getByTestId('essay-cover-figure')).toBeOnTheScreen();
    await screen.unmount();
    await cover({ height: 568 });
    await laid('essay-cover-body', 400);
    await laid('essay-cover-next', 70);
    expect(screen.queryByTestId('essay-cover-figure')).toBeNull();
    // The cover goes on offering both ways on.
    expect(screen.getByTestId('essay-cover-read')).toBeOnTheScreen();
    expect(screen.getByTestId('essay-cover-next')).toBeOnTheScreen();
  });

  describe('with the picture of a document v3', () => {
    it('draws it with the general renderer on the same plate, named by its own words', async () => {
      await cover({ figure: pictureFigure });
      expect(screen.getByTestId('essay-cover-figure')).toBeOnTheScreen();
      expect(screen.getByLabelText(describePicture(frameOfV3.picture, frameOfV3.state))).toBeOnTheScreen();
    });

    it('keeps the rules of a cover: nothing to operate, and the Scroll opens from the picture', async () => {
      const { props } = await cover({ figure: pictureFigure });
      expect(screen.queryByText('Text')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Text version of this picture' })).toBeNull();
      expect(screen.queryByRole('adjustable')).toBeNull();
      expect(screen.queryByRole('radio')).toBeNull();
      await fireEvent.press(screen.getByTestId('essay-cover-figure'));
      expect(props.onOpen).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole('button', { name: /Read|Continue|open/i })).toHaveLength(1);
    });

    it('drops the picture where the text leaves no room for it, as a kit picture is', async () => {
      const laid = (testID: string, height: number) =>
        fireEvent(screen.getByTestId(testID), 'layout', {
          nativeEvent: { layout: { x: 0, y: 0, width: 350, height } },
        });
      await cover({ figure: pictureFigure, height: 568 });
      await laid('essay-cover-body', 400);
      await laid('essay-cover-next', 70);
      expect(screen.queryByTestId('essay-cover-figure')).toBeNull();
      expect(screen.getByTestId('essay-cover-read')).toBeOnTheScreen();
    });
  });
});
