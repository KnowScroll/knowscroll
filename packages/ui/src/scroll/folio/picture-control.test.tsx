import broadStreet from '@knowscroll/scroll-model/fixtures/broad-street-v3-ci.json';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import { describePicture, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type Text, type ViewStyle } from 'react-native';
import { DisplayProvider } from '../../display/display';
import { FigureView } from './figure-view';
import { readingModelOfV3 } from './from-v3';
import { stepOfKey } from './picture-control';
import type { FigureBlock, FigureControl } from './reading-model';

// The drawing is the renderer's own business (and tested there): here it says which state and which part it was given.
jest.mock('../picture', () => {
  const { Text: Label } = jest.requireActual<{ Text: typeof Text }>('react-native');
  return {
    ...jest.requireActual<object>('../picture'),
    PictureDrawing: ({ state, pulsing }: { state: unknown; pulsing?: string }) => (
      <Label testID="drawing">{JSON.stringify({ state, pulsing })}</Label>
    ),
  };
});

/** The first figure of the fixture that has this control, as the reader would draw it. */
function figureWith(document: unknown, kind: FigureControl['kind']): FigureBlock {
  for (const section of readingModelOfV3(document as ScrollDocumentV3).sections)
    for (const block of section.blocks) if (block.kind === 'figure' && block.control?.kind === kind) return block;
  throw new Error(`no ${kind} control in the fixture`);
}

async function show(block: FigureBlock, pulsing?: string) {
  await render(
    <DisplayProvider value={{ width: 320, textScale: 1, reducedMotion: true }}>
      <FigureView
        figure={block.figure}
        control={block.control}
        height={240}
        reducedMotion
        textVersion={false}
        pulsing={pulsing}
      />
    </DisplayProvider>,
  );
}

/** What the drawing was given last. */
function drawn(): { state: Record<string, unknown>; pulsing?: string } {
  const text = screen.getByTestId('drawing').props.children as string;
  return JSON.parse(text) as { state: Record<string, unknown>; pulsing?: string };
}

const press = (name: string, role: 'button' | 'radio' = 'button') => fireEvent.press(screen.getByRole(role, { name }));

const key = (name: string) => ({ nativeEvent: { key: name }, preventDefault: jest.fn() });

function sentenceOf(block: FigureBlock, state: object): string {
  if (block.figure.kind !== 'picture') throw new Error('not a picture');
  return describePicture(block.figure.picture, state);
}

describe('the scrub control (Move Earth through its year)', () => {
  const block = figureWith(seasons, 'scrub');

  it('starts where the beat is: its position chosen, the sentence for it said, the picture as given', async () => {
    await show(block);
    expect(drawn().state).toEqual({ lit: ['jun'] });
    expect(screen.getByRole('radio', { name: 'June solstice' })).toBeChecked();
    expect(screen.getByTestId('control-sentence')).toHaveTextContent(sentenceOf(block, { lit: ['jun'] }), {
      exact: false,
    });
    expect(screen.getByLabelText('Move Earth through its year')).toBeOnTheScreen();
  });

  it('goes to the next and the previous position with the buttons, and to any with its chip', async () => {
    await show(block);
    await press('Next');
    expect(drawn().state).toEqual({ lit: ['jul'] });
    expect(screen.getByTestId('control-sentence')).toHaveTextContent(sentenceOf(block, { lit: ['jul'] }), {
      exact: false,
    });
    await press('Previous');
    await press('Previous');
    expect(drawn().state).toEqual({ lit: ['mar'] });
    await press('December solstice', 'radio');
    expect(drawn().state).toEqual({ lit: ['dec'] });
    expect(screen.getByRole('radio', { name: 'December solstice' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'June solstice' })).not.toBeChecked();
  });

  it('has no Previous before the first position and no Next after the last', async () => {
    await show(block);
    await press('January', 'radio');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await press('December solstice', 'radio');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('moves with the arrow keys, Home and End', async () => {
    await show(block);
    const chip = screen.getByRole('radio', { name: 'June solstice' });
    await fireEvent(chip, 'focus');
    await fireEvent(chip, 'keyDown', key('ArrowRight'));
    expect(drawn().state).toEqual({ lit: ['jul'] });
    await fireEvent(chip, 'keyDown', key('ArrowLeft'));
    expect(drawn().state).toEqual({ lit: ['jun'] });
    await fireEvent(chip, 'keyDown', key('End'));
    expect(drawn().state).toEqual({ lit: ['dec'] });
    await fireEvent(chip, 'keyDown', key('Home'));
    expect(drawn().state).toEqual({ lit: ['jan'] });
  });

  it('announces its sentence politely', async () => {
    await show(block);
    const status = screen.getByTestId('control-sentence');
    expect(status).toHaveProp('accessibilityLiveRegion', 'polite');
  });

  it('keeps its targets at 44 px', async () => {
    await show(block);
    for (const node of [screen.getByRole('button', { name: 'Next' }), screen.getByRole('radio', { name: 'July' })]) {
      const style = StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>) as ViewStyle;
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
      expect(style.minWidth).toBeGreaterThanOrEqual(44);
    }
  });
});

describe('the switch control (Whose pump is nearest?)', () => {
  const block = figureWith(broadStreet, 'switch');
  const flipped = { step: 9, region: 'near-broad' };

  it('is one toggle, off at first, that flips the picture to the other state and back', async () => {
    await show(block);
    expect(screen.getAllByRole('togglebutton', { name: 'Whose pump is nearest?' })).toHaveLength(1);
    const toggle = screen.getByRole('togglebutton', { name: 'Whose pump is nearest?' });
    expect(toggle.props.accessibilityState).toMatchObject({ checked: false });
    expect(drawn().state).toEqual({ step: 9 });
    await fireEvent.press(toggle);
    expect(drawn().state).toEqual(flipped);
    expect(screen.getByRole('togglebutton', { name: 'Whose pump is nearest?' }).props.accessibilityState).toMatchObject(
      {
        checked: true,
      },
    );
    await fireEvent.press(toggle);
    expect(drawn().state).toEqual({ step: 9 });
  });

  it('announces the picture’s words for the state it is in', async () => {
    await show(block);
    expect(screen.getByTestId('control-sentence')).toHaveTextContent(sentenceOf(block, { step: 9 }), { exact: false });
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Whose pump is nearest?' }));
    expect(screen.getByTestId('control-sentence')).toHaveTextContent(sentenceOf(block, flipped), { exact: false });
  });
});

describe('the pick control (Compare the leans)', () => {
  const block = figureWith(seasons, 'pick');

  it('has one button for each item with a note, none chosen and nothing said at first', async () => {
    await show(block);
    const group = screen.getByLabelText('Compare the leans');
    const items = within(group).getAllByRole('radio');
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) expect(item).not.toBeChecked();
    expect(drawn().state).toEqual({});
    expect(screen.getByTestId('control-sentence')).toHaveTextContent('', { exact: false });
  });

  it('lights the chosen item, shows its note and says it, one at a time', async () => {
    await show(block);
    await press('Mars', 'radio');
    expect(drawn().state).toEqual({ lit: ['mars'] });
    expect(screen.getByRole('radio', { name: 'Mars' })).toBeChecked();
    expect(screen.getByTestId('control-sentence')).toHaveTextContent('Seasons like ours, nearly twice as long.', {
      exact: false,
    });
    await press('Uranus', 'radio');
    expect(drawn().state).toEqual({ lit: ['uranus'] });
    expect(screen.getByRole('radio', { name: 'Mars' })).not.toBeChecked();
    expect(screen.getByTestId('control-sentence')).toHaveTextContent('Each pole in turn has the Sun overhead.', {
      exact: false,
    });
  });

  it('reveals a chosen item the beat’s upTo has not reached, so lighting it changes what the reader sees', async () => {
    // The leans are a chart of three points; the beat has revealed only the first.
    await show({ ...block, figure: { ...block.figure, state: { upTo: 1 } } });
    expect(drawn().state).toEqual({ upTo: 1 });
    await press('Uranus', 'radio');
    expect(drawn().state).toEqual({ upTo: 3, lit: ['uranus'] });
    await press('Mars', 'radio');
    expect(drawn().state).toEqual({ upTo: 2, lit: ['mars'] });
    // An item already revealed keeps the beat's upTo; nothing is taken back.
    await press('Earth', 'radio');
    expect(drawn().state).toEqual({ upTo: 1, lit: ['earth'] });
  });

  it('moves with the arrow keys', async () => {
    await show(block);
    const earth = screen.getByRole('radio', { name: 'Earth' });
    await fireEvent(earth, 'focus');
    await fireEvent(earth, 'keyDown', key('ArrowRight'));
    expect(drawn().state).toEqual({ lit: ['mars'] });
    await fireEvent(earth, 'keyDown', key('End'));
    expect(drawn().state).toEqual({ lit: ['uranus'] });
  });
});

describe('a picture figure', () => {
  it('draws no control where its block has none', async () => {
    const block = figureWith(seasons, 'scrub');
    await show({ ...block, control: undefined });
    expect(screen.queryByLabelText('Move Earth through its year')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('control-sentence')).not.toBeOnTheScreen();
  });

  it('emphasises a part its picture has, and only that', async () => {
    const block = figureWith(seasons, 'scrub');
    await show(block, 'jan');
    expect(drawn().pulsing).toBe('jan');
  });

  it('leaves a part of another picture alone', async () => {
    const block = figureWith(seasons, 'scrub');
    await show(block, 'pump-broad');
    expect(drawn().pulsing).toBeUndefined();
  });
});

describe('the keys of a choice', () => {
  it('steps by the arrows and goes to either end with Home and End, and stays inside', () => {
    expect(stepOfKey('ArrowRight', 1, 4)).toBe(2);
    expect(stepOfKey('ArrowDown', 3, 4)).toBe(3);
    expect(stepOfKey('ArrowLeft', 1, 4)).toBe(0);
    expect(stepOfKey('ArrowUp', 0, 4)).toBe(0);
    expect(stepOfKey('Home', 2, 4)).toBe(0);
    expect(stepOfKey('End', 0, 4)).toBe(3);
  });

  it('starts from the end when going back with nothing chosen, and leaves other keys alone', () => {
    expect(stepOfKey('ArrowLeft', -1, 4)).toBe(3);
    expect(stepOfKey('ArrowRight', -1, 4)).toBe(0);
    expect(stepOfKey('a', 1, 4)).toBeUndefined();
    expect(stepOfKey('Enter', 1, 4)).toBeUndefined();
    expect(stepOfKey('ArrowRight', 0, 0)).toBeUndefined();
  });
});
