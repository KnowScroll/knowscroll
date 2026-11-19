import { render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '../../display/display';
import { BeatView, type BeatViewProps } from './beat-view';
import type { Beat } from './reading-model';

const beat: Beat = {
  id: 'stop-1',
  kind: 'prose',
  text: [{ kind: 'paragraph', text: 'The planet leans, and that is the whole reason.' }],
  simple: 'The planet is tilted, so we get seasons.',
  notes: [],
};

async function show(overrides: Partial<BeatViewProps> = {}) {
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <BeatView
        beat={beat}
        textVersion={false}
        simpler={false}
        openNotes={new Set()}
        onToggleNote={jest.fn()}
        {...overrides}
      />
    </DisplayProvider>,
  );
}

describe('a beat of the essay (D-429)', () => {
  it('has no "Say it simpler" link under its paragraph, even where the writer gave plainer words', async () => {
    await show();
    expect(screen.getByText('The planet leans, and that is the whole reason.')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
    expect(screen.queryByText('Say it simpler')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('simpler-toggle')).not.toBeOnTheScreen();
  });

  it('swaps its words for the plainer ones when the reader switches it, and shows no link then either', async () => {
    await show({ simpler: true });
    expect(screen.getByTestId('simpler-text')).toHaveTextContent('The planet is tilted, so we get seasons.');
    expect(screen.queryByText('The planet leans, and that is the whole reason.')).not.toBeOnTheScreen();
    expect(screen.queryByText('Undo simpler')).not.toBeOnTheScreen();
    expect(screen.queryByRole('button')).not.toBeOnTheScreen();
  });
});
