import { act, configure, fireEvent, screen } from '@testing-library/react-native';
import { ScrollArticle } from '../article';
import { altitudeSimulation, floorSimulation, interestSimulation, pendulumSimulation } from '../fixtures/blocks';
import { HORIZONTAL_PAN } from '../gestures/arbitration';
import { createMemoryBlockStateStore } from '../state';
import { anyNumber, articleOf, diagnosticsDouble, observerDouble, show } from '../../test-support/scroll';
import { lastPan, panConfigs } from '../../test-support/gesture-handler.mock';

/** The simulation: closed formulas, controls bound to declared keys, four views, its notice, its text version. */

beforeAll(() => {
  configure({ defaultIncludeHiddenElements: true });
});

afterAll(() => {
  configure({ defaultIncludeHiddenElements: false });
});

const key = (blockId: string) => ({ assetId: 'fixture-one', revision: 1, blockId });
const press = (name: string) => fireEvent.press(screen.getByRole('button', { name }));
const noop = () => undefined;
const slider = () => screen.getByRole('slider', { name: 'String length' });
const event = (x: number) => ({ x, y: 0, translationX: 0, translationY: 0 });

describe('a simulation with a slider', () => {
  beforeEach(() => {
    panConfigs.length = 0;
  });

  it('is a real slider for assistive technology: a name, a range and the value in words', async () => {
    await show(<ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} />);

    expect(slider()).toHaveAccessibilityValue({ min: 0.25, max: 4, now: 1, text: '1.00 m' });
    expect(slider()).toHaveProp('aria-valuetext', '1.00 m');
    expect(screen.getByText('0.25 m')).toBeOnTheScreen();
    expect(screen.getByText('4.00 m')).toBeOnTheScreen();
  });

  it('computes what it shows with the package’s closed formulas, and says the result in a sentence and a band', async () => {
    await show(<ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} />);

    expect(screen.getByText('A 1.00 m string swings once in about 2.0 s.')).toBeOnTheScreen();
    expect(screen.getByText('A slow, lazy swing.')).toBeOnTheScreen();
  });

  it('shows its notice, always, next to the view, and again with the model note', async () => {
    await show(<ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} />);

    expect(screen.getByText('Illustrative')).toBeOnTheScreen();
    expect(
      screen.getByText('Illustrative. A simple model: small swings, no friction, a light string.'),
    ).toBeOnTheScreen();
  });

  it('moves one step per increment or decrement action (VoiceOver, TalkBack), keeps it, and reports a control', async () => {
    const store = createMemoryBlockStateStore();
    const watcher = observerDouble();
    await show(
      <ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} store={store} observer={watcher} />,
    );

    await fireEvent(slider(), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });

    expect(slider()).toHaveAccessibilityValue({ now: 1.25, text: '1.25 m' });
    expect(screen.getByText('A 1.25 m string swings once in about 2.2 s.')).toBeOnTheScreen();
    expect(store.get(key('sim-pendulum'))).toEqual({ type: 'simulation', params: { length: 1.25 } });
    expect(watcher.onBlockInteraction).toHaveBeenCalledWith({
      blockId: 'sim-pendulum',
      kind: 'control',
      at: anyNumber,
    });

    await fireEvent(slider(), 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(slider()).toHaveAccessibilityValue({ now: 1 });
  });

  it('answers the keyboard: arrows by a step, Home and End to the ends, and keeps the page from scrolling', async () => {
    await show(<ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} />);
    const preventDefault = jest.fn();

    await fireEvent(slider(), 'keyDown', { nativeEvent: { key: 'ArrowRight' }, preventDefault });
    expect(slider()).toHaveAccessibilityValue({ text: '1.25 m' });
    await fireEvent(slider(), 'keyDown', { nativeEvent: { key: 'End' }, preventDefault });
    expect(slider()).toHaveAccessibilityValue({ text: '4.00 m' });
    await fireEvent(slider(), 'keyDown', { nativeEvent: { key: 'Home' }, preventDefault });
    expect(slider()).toHaveAccessibilityValue({ text: '0.25 m' });
    expect(preventDefault).toHaveBeenCalledTimes(3);

    await fireEvent(slider(), 'keyDown', { nativeEvent: { key: 'Tab' }, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it('declares a horizontal capture, and asks the gesture handler for it only after the axis locks', async () => {
    await show(<ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} />);
    const pan = lastPan();

    expect(pendulumSimulation('x').gesture).toBe('horizontal');
    expect(pan.activeOffsetX).toEqual(HORIZONTAL_PAN.activeOffsetX);
    expect(pan.failOffsetY).toEqual(HORIZONTAL_PAN.failOffsetY);
    expect(pan.runOnJS).toBe(true);
  });

  it('follows a drag live, keeps the value only on release, and reports one drag', async () => {
    const store = createMemoryBlockStateStore();
    const watcher = observerDouble();
    await show(
      <ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} store={store} observer={watcher} />,
    );
    await fireEvent(slider(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 332, height: 48 } } });

    await act(() => {
      lastPan().onActivate?.(event(16 + 150));
    });
    expect(slider()).toHaveAccessibilityValue({ text: '2.25 m' });
    await act(() => {
      lastPan().onUpdate?.(event(16 + 300));
    });
    expect(slider()).toHaveAccessibilityValue({ text: '4.00 m' });
    expect(screen.getByText('A 4.00 m string swings once in about 4.0 s.')).toBeOnTheScreen();
    // Nothing is kept or reported while the finger is down.
    expect(store.get(key('sim-pendulum'))).toBeNull();
    expect(watcher.onBlockInteraction).not.toHaveBeenCalled();

    await act(() => {
      lastPan().onDeactivate?.(event(16 + 300));
      lastPan().onFinalize?.(event(16 + 300));
    });

    expect(store.get(key('sim-pendulum'))).toEqual({ type: 'simulation', params: { length: 4 } });
    const kinds = watcher.onBlockInteraction.mock.calls.map(([entry]: [{ kind: string }]) => entry.kind);
    expect(kinds).toEqual(['drag']);
  });

  it('starts over on Reset, which is off while the block is at its start', async () => {
    const store = createMemoryBlockStateStore();
    await show(<ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} store={store} />);
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    await fireEvent(slider(), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();

    await press('Reset');

    expect(slider()).toHaveAccessibilityValue({ now: 1 });
    expect(store.get(key('sim-pendulum'))).toBeNull();
  });

  it('keeps its values by (revision, block id): they return with the article, and a new revision starts over', async () => {
    const store = createMemoryBlockStateStore();
    const first = await show(
      <ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} store={store} />,
    );
    await fireEvent(slider(), 'keyDown', { nativeEvent: { key: 'End' }, preventDefault: noop });
    await first.unmount();

    const again = await show(
      <ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} store={store} />,
    );
    expect(slider()).toHaveAccessibilityValue({ text: '4.00 m' });
    await again.unmount();

    await show(<ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')], 2)} store={store} />);
    expect(slider()).toHaveAccessibilityValue({ text: '1.00 m' });
  });

  it('swaps the slider for a stepper under the text version, and the view for its outputs in words', async () => {
    await show(<ScrollArticle document={articleOf([pendulumSimulation('sim-pendulum')])} initialTextVersion />);

    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByText('Swing time: 2.0 s')).toBeOnTheScreen();
    expect(screen.getByText('Illustrative')).toBeOnTheScreen();

    await press('More String length');

    expect(screen.getByText('1.25 m')).toBeOnTheScreen();
    expect(screen.getByText('Swing time: 2.2 s')).toBeOnTheScreen();
    await press('Less String length');
    expect(screen.getByText('1.00 m')).toBeOnTheScreen();
  });
});

describe('a simulation with a typed number and cards', () => {
  it('reads what is typed as a reader writes it, snaps it onto the grid, clamps it, and puts back what is not a number', async () => {
    await show(<ScrollArticle document={articleOf([altitudeSimulation('sim-altitude')])} />);
    const field = () => screen.getByLabelText('Your altitude');
    expect(field().props.value).toBe('0 m');

    await fireEvent(field(), 'focus');
    await fireEvent.changeText(field(), '2,000');
    await fireEvent(field(), 'blur');
    expect(field().props.value).toBe('2,000 m');
    expect(screen.getByText('93.4 °C')).toBeOnTheScreen();
    expect(screen.getByText('85.4 °C')).toBeOnTheScreen();

    await fireEvent(field(), 'focus');
    await fireEvent.changeText(field(), '2,600');
    await fireEvent(field(), 'blur');
    expect(field().props.value).toBe('2,500 m');

    await fireEvent(field(), 'focus');
    await fireEvent.changeText(field(), '99999');
    await fireEvent(field(), 'blur');
    expect(field().props.value).toBe('4,000 m');

    await fireEvent(field(), 'focus');
    await fireEvent.changeText(field(), 'high up');
    await fireEvent(field(), 'blur');
    expect(field().props.value).toBe('4,000 m');
  });

  it('says a personal value stays on the device, and draws a card per output with its words', async () => {
    await show(<ScrollArticle document={articleOf([altitudeSimulation('sim-altitude')])} />);

    expect(screen.getByText('Stays on this device unless you choose to include it when you share.')).toBeOnTheScreen();
    expect(screen.getByText('Boiling point')).toBeOnTheScreen();
    expect(screen.getByText('Gentle simmer')).toBeOnTheScreen();
    expect(screen.getByText('Less air pressure, a lower boil.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Boiling point: 100.0 °C')).toBeOnTheScreen();
  });

  it('has steppers beside the field, off at the ends of the range', async () => {
    await show(<ScrollArticle document={articleOf([altitudeSimulation('sim-altitude')])} />);
    expect(screen.getByRole('button', { name: 'Less Your altitude' })).toBeDisabled();

    await press('More Your altitude');

    expect(screen.getByLabelText('Your altitude').props.value).toBe('250 m');
  });
});

describe('a simulation with a stepper and a readout, and one with an area', () => {
  it('steps by one and recomputes the readout from a formula', async () => {
    await show(<ScrollArticle document={articleOf([interestSimulation('sim-interest')])} />);
    expect(screen.getByText('10 years')).toBeOnTheScreen();
    expect(screen.getByText('149')).toBeOnTheScreen();
    expect(screen.getByText('Doubles after: 17.3 years')).toBeOnTheScreen();

    await press('More Years');

    expect(screen.getByText('11 years')).toBeOnTheScreen();
    expect(screen.getByText('155')).toBeOnTheScreen();
    expect(screen.getByText('After 11 years, 100 grows to about 155.')).toBeOnTheScreen();
  });

  it('draws a bar and a square whose area follows the output, and names both', async () => {
    await show(<ScrollArticle document={articleOf([floorSimulation('sim-floor')])} />);
    expect(screen.getByText('Side: 3 m')).toBeOnTheScreen();
    expect(screen.getByText('Floor: 9 m²')).toBeOnTheScreen();

    await fireEvent(screen.getByRole('slider', { name: 'Room side' }), 'keyDown', {
      nativeEvent: { key: 'ArrowRight' },
      preventDefault: noop,
    });

    expect(screen.getByText('Side: 4 m')).toBeOnTheScreen();
    expect(screen.getByText('Floor: 16 m²')).toBeOnTheScreen();
    expect(screen.getByText('4 m on each side gives 16 m² of floor.')).toBeOnTheScreen();
  });
});

describe('a value the model cannot show', () => {
  function pole() {
    const base = interestSimulation('sim-pole');
    const { readout: _readout, ...data } = base.data;
    return {
      ...base,
      data: {
        ...data,
        params: [
          {
            key: 'years',
            label: 'Years',
            min: 0,
            max: 4,
            step: 1,
            default: 0,
            control: 'stepper' as const,
            format: { decimals: 0, grouping: false, approximate: false },
          },
        ],
        constants: [],
        outputs: [
          {
            key: 'inverse',
            label: 'One over the years',
            formula: { kind: 'ratio' as const, numerator: 1, denominator: 'years' },
            format: { decimals: 1, grouping: false, approximate: false },
          },
        ],
        view: { kind: 'readout' as const, primary: 'inverse' },
      },
    };
  }

  it('shows the block’s own words in place of the view, never NaN or Infinity, and records a diagnostic', async () => {
    const watcher = diagnosticsDouble();
    await show(<ScrollArticle document={articleOf([pole()])} diagnostics={watcher} />);

    expect(screen.getByText("Interactive couldn't load · text version")).toBeOnTheScreen();
    expect(
      screen.getByText(
        'A starting amount of one hundred grows by four percent a year: after ten years it is about one hundred and fifty.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
    expect(watcher.onRenderFallback).toHaveBeenCalledWith({
      blockId: 'sim-pole',
      blockType: 'simulation',
      reason: 'non-finite-output',
      at: anyNumber,
    });
  });

  it('keeps its controls, so the reader can move to a value that works', async () => {
    await show(<ScrollArticle document={articleOf([pole()])} />);

    await press('More Years');

    expect(screen.queryByText("Interactive couldn't load · text version")).toBeNull();
    expect(screen.getByText('1.0')).toBeOnTheScreen();
  });
});
