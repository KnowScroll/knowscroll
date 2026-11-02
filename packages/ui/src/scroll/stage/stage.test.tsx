import { render, screen } from '@testing-library/react-native';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import tides from '@knowscroll/scroll-model/fixtures/tides-stage-ci.json';
import { Stage, type StageProps } from './stage';
import { stageEntryAt } from './stage-state';

const document = seasons as unknown as ScrollDocumentV2;
const stage = document.stage;
if (stage === undefined) throw new Error('the fixture has a stage');
const props = { document: { stops: document.stops, stage }, stopId: 'final-tilt', reducedMotion: true, height: 240 };

/** The pinned stage at the Final call, over the labelled CI fixture, with the tilt the reader has turned it to. */
describe('the stage at a tilt the reader has turned (D-187)', () => {
  it("names the picture for a screen reader by the tilt it is turned to, and by the state at today's tilt", async () => {
    const view = await render(<Stage {...props} />);
    expect(screen.getByLabelText(/tilted by 23.4 degrees/)).toBeOnTheScreen();
    await view.rerender(<Stage {...props} tilt={0} />);
    expect(screen.getByLabelText(/stands straight up/)).toBeOnTheScreen();
    await view.rerender(<Stage {...props} tilt={60} />);
    expect(screen.getByLabelText(/tilted by 60 degrees/)).toBeOnTheScreen();
    await view.rerender(<Stage {...props} tilt={23.4} />);
    expect(screen.getByLabelText(/tilted by 23.4 degrees/)).toBeOnTheScreen();
  });

  it('redraws the one picture for each step of the slider and never replaces it', async () => {
    const view = await render(<Stage {...props} tilt={10} />);
    const drawing = screen.getByLabelText(/Earth circles the Sun/).children[0];
    expect(drawing).toBeDefined();
    for (const tilt of [11, 12, 40, 0, 90]) {
      await view.rerender(<Stage {...props} tilt={tilt} />);
      expect(screen.getByLabelText(/Earth circles the Sun/).children[0]).toBe(drawing);
    }
  });
});

describe('the tilt tag on the picture (V3 F9, C3)', () => {
  it('says the tilt the picture is turned to while a tilt is bound, and nothing otherwise', async () => {
    const view = await render(<Stage {...props} />);
    expect(screen.queryByTestId('stage-tilt-tag', { includeHiddenElements: true })).not.toBeOnTheScreen();
    await view.rerender(<Stage {...props} tilt={0} />);
    expect(screen.getByTestId('stage-tilt-tag', { includeHiddenElements: true })).toHaveTextContent('TILT 0°');
    await view.rerender(<Stage {...props} tilt={60} />);
    expect(screen.getByTestId('stage-tilt-tag', { includeHiddenElements: true })).toHaveTextContent('TILT 60°');
    await view.rerender(<Stage {...props} tilt={23.4} />);
    expect(screen.getByTestId('stage-tilt-tag', { includeHiddenElements: true })).toHaveTextContent('TILT 23.4°');
  });

  it('is left out of the text version, which already says the tilt in words', async () => {
    await render(<Stage {...props} tilt={0} textVersion />);
    expect(screen.queryByTestId('stage-tilt-tag', { includeHiddenElements: true })).not.toBeOnTheScreen();
  });
});

describe('the stage at the end of a Scroll (V3 F10)', () => {
  it('turns into the picture of the whole journey, named by the same months, where its kit can draw one', async () => {
    const view = await render(<Stage {...props} stopId="the-year" />);
    expect(screen.queryByLabelText(/The picture you built/)).not.toBeOnTheScreen();
    await view.rerender(<Stage {...props} stopId="the-year" recap />);
    expect(
      screen.getByLabelText(/The picture you built: .*marked 1 in June, 2 in January and 3 in March/),
    ).toBeOnTheScreen();
    await view.rerender(<Stage {...props} stopId="the-year" recap textVersion />);
    expect(screen.getByText(/The picture you built: /)).toBeOnTheScreen();
  });
});

describe('the recap of a Scroll whose picture stood on the orbit at two months, and at one (V3 F10, D-368)', () => {
  /** The fixture with its picture on the orbit only at the months given: every other orbit state is set back to the Sun and Earth view. */
  function standingAt(months: readonly string[]) {
    const held = document.stage;
    if (held?.kit !== 'earth-sky.v1') throw new Error('the fixture has an Earth & sky stage');
    const reduced = {
      stops: document.stops,
      stage: {
        ...held,
        states: held.states.map((entry) =>
          (entry.state.view === 'orbit' || entry.state.view === 'orbit-stretched') &&
          !months.includes(entry.state.earthAt)
            ? { ...entry, state: { ...entry.state, view: 'sun-earth' as const } }
            : entry,
        ),
      },
    } as unknown as StageProps['document'];
    return { ...props, document: reduced, stopId: 'the-year', reducedMotion: true };
  }

  it('draws the recap with two months, numbered in the order the Scroll showed them, and names both in words', async () => {
    const own = standingAt(['jun', 'jan']);
    const view = await render(<Stage {...own} recap />);
    expect(
      screen.getByLabelText(/The picture you built: .*marked 1 in June and 2 in January, numbered/),
    ).toBeOnTheScreen();
    await view.rerender(<Stage {...own} recap textVersion />);
    expect(screen.getByText(/marked 1 in June and 2 in January/)).toBeOnTheScreen();
  });

  it('draws none with one month: the stage keeps its last state, as before', async () => {
    const own = standingAt(['jun']);
    await render(<Stage {...own} recap />);
    expect(screen.queryByLabelText(/The picture you built/)).not.toBeOnTheScreen();
  });
});

describe('a kit that has no recap, at the end of its Scroll (V3 F10)', () => {
  it('keeps its last state and says so in the same words as before', async () => {
    const other = tides as unknown as ScrollDocumentV2;
    const stageOf = other.stage;
    if (stageOf === undefined) throw new Error('the fixture has a stage');
    const last = other.stops.at(-1)!.id;
    const own = { document: { stops: other.stops, stage: stageOf }, stopId: last, reducedMotion: true, height: 240 };
    const view = await render(<Stage {...own} />);
    const expected = stageEntryAt(stageOf, other.stops, last).alt;
    expect(screen.getByLabelText(expected)).toBeOnTheScreen();
    await view.rerender(<Stage {...own} recap />);
    expect(screen.getByLabelText(expected)).toBeOnTheScreen();
    expect(screen.queryByLabelText(/The picture you built/)).not.toBeOnTheScreen();
  });
});
