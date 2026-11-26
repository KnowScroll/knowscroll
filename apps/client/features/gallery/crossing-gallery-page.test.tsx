import { act, fireEvent, render } from '@testing-library/react-native';
import { View as MockView } from 'react-native';
import { DisplayProvider } from '@knowscroll/ui';
import type { CrossingFrame } from '../universe/crossing/crossing-frame';
import { CrossingGalleryPage } from './crossing-gallery-page';

// The real page. The stage (canvas, three.js) and the clock are stand-ins: the page's job is to turn the address and
// the screen's size into a frame and hand it over, which is what is checked here. The browser proves the pixels.
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams }));

interface StageProps {
  frame: CrossingFrame;
  size: { width: number; height: number };
  behindSeed: string;
  aheadSeed: string;
  preserveDrawingBuffer?: boolean;
  onDrawn?: (frame: CrossingFrame) => void;
  onFailure?: (reason: string) => void;
}
let mockStage: StageProps | null = null;
jest.mock('../universe/crossing/crossing-stage', () => ({
  CrossingStage: (props: StageProps) => {
    mockStage = props;
    return <MockView testID="stage-stub" />;
  },
}));
let mockClockQ = 0;
const mockClock = jest.fn((_playing: boolean, _seconds: number) => mockClockQ);
jest.mock('../universe/crossing/use-crossing-clock', () => ({
  useCrossingClock: (playing: boolean, seconds: number) => mockClock(playing, seconds),
}));

beforeEach(() => {
  mockParams = {};
  mockStage = null;
  mockClockQ = 0;
  mockClock.mockClear();
});

async function open(params: Record<string, string> = {}, reducedMotion = false) {
  mockParams = params;
  const screen = await render(
    <DisplayProvider value={{ reducedMotion }}>
      <CrossingGalleryPage />
    </DisplayProvider>,
  );
  return screen;
}
const lay = (screen: Awaited<ReturnType<typeof open>>, width = 390, height = 844) =>
  fireEvent(screen.getByTestId('ks-crossing-page'), 'layout', { nativeEvent: { layout: { width, height } } });

describe('the crossing gallery page', () => {
  it('draws nothing until the screen has a size, then hands the stage the frame for that size', async () => {
    const screen = await open({ q: '0.30' });
    expect(screen.queryByTestId('stage-stub')).toBeNull();
    await lay(screen, 320, 700);
    expect(screen.getByTestId('stage-stub')).toBeTruthy();
    expect(mockStage!.size).toEqual({ width: 320, height: 700 });
    expect(mockStage!.frame.q).toBeCloseTo(0.3);
    expect(mockStage!.frame.shader.centre[1]).toBeCloseTo((0.5 - 0.43) * (700 / 320));
    expect(mockStage!.preserveDrawingBuffer).toBe(true);
  });

  it('shows one still at the q of the address, with the friend and what is shared', async () => {
    const screen = await open({ q: '0.64', name: 'Mei', shared: 'Maps,Tides' });
    await lay(screen);
    expect(mockStage!.frame.q).toBeCloseTo(0.64);
    expect(mockStage!.frame.names.map((entry) => entry.text)).toEqual(['Maps', 'Tides']);
    expect(mockClock).toHaveBeenCalledWith(false, 7.5);
  });

  it('puts your bubble behind and theirs ahead on the way out, and swaps them (and the names) on the way home', async () => {
    const out = await open({ q: '0.10', name: 'Mei' });
    await lay(out);
    expect(mockStage).toMatchObject({ behindSeed: 'you', aheadSeed: 'friend:Mei' });
    const home = await open({ q: '0.64', name: 'Mei', dir: 'home' });
    await lay(home);
    expect(mockStage).toMatchObject({ behindSeed: 'friend:Mei', aheadSeed: 'you' });
    expect(mockStage!.frame.names).toEqual([]);
    expect(mockClock).toHaveBeenLastCalledWith(false, 3.8);
  });

  it('asks the clock for the shorter film after a first crossing', async () => {
    const screen = await open({ seen: '1' });
    await lay(screen);
    expect(mockClock).toHaveBeenLastCalledWith(false, 3.6);
  });

  it('plays from the clock instead of the address when play is on', async () => {
    mockClockQ = 0.5;
    const screen = await open({ q: '0.10', play: '1' });
    await lay(screen);
    expect(mockClock).toHaveBeenLastCalledWith(true, 7.5);
    expect(mockStage!.frame.q).toBeCloseTo(0.5);
  });

  it('plays no film under reduced motion: a note, no stage and no running clock', async () => {
    const screen = await open({ play: '1' }, true);
    await lay(screen);
    expect(screen.getByTestId('ks-crossing-reduced')).toBeTruthy();
    expect(screen.queryByTestId('stage-stub')).toBeNull();
    expect(mockClock).toHaveBeenLastCalledWith(false, 7.5);
  });

  it('still draws a still under reduced motion, with no shake', async () => {
    const screen = await open({ q: '0.39' }, true);
    await lay(screen);
    expect(screen.queryByTestId('ks-crossing-reduced')).toBeNull();
    expect(mockStage!.frame.shake).toEqual({ x: 0, y: 0 });
  });

  it('says the frame is on the canvas only once the stage says so', async () => {
    const screen = await open({ q: '0.30' });
    await lay(screen);
    expect(screen.queryByTestId('ks-crossing-ready')).toBeNull();
    await act(() => mockStage!.onDrawn!(mockStage!.frame));
    expect(screen.getByTestId('ks-crossing-ready').props.accessibilityLabel).toBe('drawn q 0.300');
  });

  it('says why when the shader cannot be drawn', async () => {
    const screen = await open({ q: '0.30' });
    await lay(screen);
    expect(screen.queryByTestId('ks-crossing-failure')).toBeNull();
    await act(() => mockStage!.onFailure!('webgl-unavailable'));
    expect(screen.getByTestId('ks-crossing-failure')).toBeTruthy();
  });
});
