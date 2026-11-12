import { render } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { fixtureId, sceneFixture } from '../universe.fixture';
import { indexUniverse } from '../universe-layout';
import { ANCHOR_CAP } from './detail-set';
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

describe('the targets over a map at scale (D-417)', () => {
  it('never carry more than the cap, however many anchors the drawing offers', async () => {
    const base = sceneFixture(5).descriptors[0]!;
    const systems = Array.from({ length: 400 }, (_, n) => ({
      ...base,
      objectId: fixtureId(7000 + n),
      parentId: fixtureId(1),
      kind: 'system' as const,
      label: `CI system ${n}`,
      target: { kind: 'system' as const, objectId: fixtureId(7000 + n) },
    }));
    const anchors: SpaceAnchor[] = systems.map((system, n) => ({
      id: system.objectId,
      kind: 'system',
      name: system.label,
      systemId: system.objectId,
      x: (n % 20) * 19,
      y: Math.floor(n / 20) * 40,
      radiusPx: 10,
      visible: true,
    }));
    const view = await render(
      <DisplayProvider value={{ reducedMotion: false }}>
        <SpaceOverlay
          anchors={anchors}
          far
          index={indexUniverse(systems, [])}
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
    expect(view.getAllByTestId(/^universe-focus-/)).toHaveLength(ANCHOR_CAP);
  });
});
