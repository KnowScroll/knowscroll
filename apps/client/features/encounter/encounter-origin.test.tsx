import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import type { EncounterEntry } from './encounter-history';
import { formatSwitchOrigin } from './encounter-origin';
import { EncounterOriginChip } from './encounter-origin-chip';

function entry(kind: 'reel' | 'scroll', relation: string, position?: EncounterEntry['position']): EncounterEntry {
  return {
    kind,
    offer: { explanationUnitId: 'unit-1', relation: { kind: relation } },
    position,
  } as unknown as EncounterEntry;
}
const parkedReel = entry('reel', 'discovery', { kind: 'reel', positionMs: 31_000, playing: false, muted: false });

describe('where a Scroll was opened from (E06)', () => {
  it('names the Reel and its playhead when the Scroll came from the format switch', () => {
    const scroll = entry('scroll', 'format_variant');
    expect(formatSwitchOrigin([parkedReel, scroll], scroll)).toEqual({
      from: 'From the Reel at 0:31',
      backLabel: 'Back to Reel',
    });
  });

  it('says only "From the Reel" when the Reel never played', () => {
    const scroll = entry('scroll', 'format_variant');
    const idle = entry('reel', 'discovery', { kind: 'reel', positionMs: 0, playing: false, muted: false });
    expect(formatSwitchOrigin([idle, scroll], scroll)?.from).toBe('From the Reel');
  });

  it('shows nothing for a Scroll that is not a format switch, is first in the trail, or follows another subject', () => {
    const asked = entry('scroll', 'discovery');
    expect(formatSwitchOrigin([parkedReel, asked], asked)).toBeUndefined();
    const first = entry('scroll', 'format_variant');
    expect(formatSwitchOrigin([first], first)).toBeUndefined();
    const other = { ...parkedReel, offer: { explanationUnitId: 'unit-2', relation: { kind: 'discovery' } } } as never;
    expect(formatSwitchOrigin([other, first], first)).toBeUndefined();
  });

  it('is a button named by the place and the way back, and pressing it goes back', async () => {
    const back = jest.fn();
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <EncounterOriginChip origin={{ from: 'From the Reel at 0:31', backLabel: 'Back to Reel' }} onBack={back} />
      </DisplayProvider>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'From the Reel at 0:31. Back to Reel' }));
    expect(back).toHaveBeenCalledTimes(1);
  });
});
