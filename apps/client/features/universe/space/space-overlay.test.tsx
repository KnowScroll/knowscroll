import { render } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { indexUniverse } from '../universe-layout';
import { SpaceOverlay } from './space-overlay';
import type { SpaceAnchor } from './space-surface';

const station = (mapCaption: string | undefined): SpaceAnchor => ({
  id: 'room-earth',
  kind: 'station',
  name: 'Earth room',
  ...(mapCaption === undefined ? {} : { caption: `${mapCaption} · The Lantern`, mapCaption }),
  systemId: 'system-earth',
  x: 200,
  y: 300,
  radiusPx: 10,
  visible: true,
});

function show(anchor: SpaceAnchor) {
  return render(
    <DisplayProvider value={{ reducedMotion: false }}>
      <SpaceOverlay
        anchors={[anchor]}
        far={false}
        index={indexUniverse([], [])}
        size={{ width: 390, height: 844 }}
        selectedId={null}
        lately={false}
        lastPlaceId={undefined}
        onSystem={jest.fn()}
        onPlanet={jest.fn()}
        onStation={jest.fn()}
        onDust={jest.fn()}
      />
    </DisplayProvider>,
  );
}

describe('the label under a room station on the map (D-268)', () => {
  it('says what is live beside the count', async () => {
    const view = await show(station('2 of 7 · Reel live'));
    expect(view.getByText('Earth room · 2 of 7 · Reel live')).toBeTruthy();
  });

  it('is the name and the count while nothing is on, without the constellation name', async () => {
    const view = await show(station('2 of 7'));
    expect(view.getByText('Earth room · 2 of 7')).toBeTruthy();
  });

  it('is only the name for a station that carries no sky', async () => {
    const view = await show(station(undefined));
    expect(view.getByText('Earth room')).toBeTruthy();
  });
});
