import { render, screen } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import type { SpaceAnchor } from '../space/space-surface';
import { StationLayer } from './station-layer';
import { stationLookOf, type StationLook } from './station-look';

const anchor = (id: string, over: Partial<SpaceAnchor> = {}): SpaceAnchor => ({
  id,
  kind: 'station',
  name: id,
  systemId: 'system',
  x: 120,
  y: 300,
  radiusPx: 30,
  visible: true,
  ...over,
});
const look = (over: Partial<StationLook> = {}): StationLook => ({
  ...stationLookOf({ id: 'a', name: 'A', systemId: 's', position: { x: 0, y: 0, z: 0 } }),
  ...over,
});
/** The layer is hidden from assistive technology, so a query must say it may look at hidden things too. */
const find = (testID: string) => screen.queryByTestId(testID, { includeHiddenElements: true });
const findAll = (testID: string) => screen.queryAllByTestId(testID, { includeHiddenElements: true });

afterEach(() => jest.restoreAllMocks());

describe('the station layer', () => {
  it('draws one station for each anchor it has a look for, and none for one it has not', async () => {
    await render(
      <StationLayer
        anchors={[anchor('a'), anchor('b'), anchor('c')]}
        looks={
          new Map([
            ['a', look()],
            ['b', look()],
          ])
        }
        reducedMotion
      />,
    );
    expect(find('voyage-station-drawn-a')).not.toBeNull();
    expect(find('voyage-station-drawn-b')).not.toBeNull();
    expect(find('voyage-station-drawn-c')).toBeNull();
  });

  it('is hidden from assistive technology and takes no touch', async () => {
    await render(<StationLayer anchors={[anchor('a')]} looks={new Map([['a', look()]])} reducedMotion />);
    const layer = find('voyage-stations')!;
    expect(layer.props['aria-hidden']).toBe(true);
    expect(layer.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(layer.props.pointerEvents).toBe('none');
    expect(screen.queryByTestId('voyage-stations')).toBeNull();
  });

  it('puts a station on its anchor', async () => {
    await render(
      <StationLayer anchors={[anchor('a', { x: 120, y: 300 })]} looks={new Map([['a', look()]])} reducedMotion />,
    );
    expect(StyleSheet.flatten(find('voyage-station-drawn-a')!.props.style)).toMatchObject({ left: 120, top: 300 });
  });

  it('shows the seven lights only for a station with a sky, and only once it is big enough', async () => {
    await render(
      <StationLayer
        anchors={[anchor('member'), anchor('outsider'), anchor('small', { radiusPx: 6 })]}
        looks={
          new Map([
            ['member', look({ lit: 3 })],
            ['outsider', look({ lit: undefined })],
            ['small', look({ lit: 3 })],
          ])
        }
        reducedMotion
      />,
    );
    const skies = findAll('voyage-station-sky');
    expect(skies).toHaveLength(1);
    // Inside the member's station.
    expect(find('voyage-station-drawn-member')).toContainElement(skies[0]!);
  });

  it('starts no animation under reduced motion', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    await render(<StationLayer anchors={[anchor('a')]} looks={new Map([['a', look()]])} reducedMotion />);
    expect(timing).not.toHaveBeenCalled();
  });

  it('runs one clock each for the blink and the hover, however many stations there are', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    await render(
      <StationLayer
        anchors={[anchor('a'), anchor('b'), anchor('c')]}
        looks={
          new Map([
            ['a', look()],
            ['b', look()],
            ['c', look()],
          ])
        }
        reducedMotion={false}
      />,
    );
    expect(timing).toHaveBeenCalledTimes(2);
  });

  it('pulses the light of a live station instead of blinking it', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    await render(
      <StationLayer anchors={[anchor('a')]} looks={new Map([['a', look({ live: true })]])} reducedMotion={false} />,
    );
    // The hover and the pulse; no blink.
    expect(timing).toHaveBeenCalledTimes(2);
    expect(timing.mock.calls.map(([, config]) => config.duration)).toEqual([5712, 1571]);
  });

  it('runs no clock for a calm station’s light: it neither blinks nor pulses', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    await render(
      <StationLayer
        anchors={[anchor('a')]}
        looks={new Map([['a', look({ calm: true, live: true })]])}
        reducedMotion={false}
      />,
    );
    expect(timing).toHaveBeenCalledTimes(1);
  });
});
