import { act, fireEvent, screen } from '@testing-library/react-native';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { renderOn } from '../test-support/render';
import { ReelPlayer, type ReelPlayerProps } from './reel-player';

// The native SDK is a recording stand-in here; real playback belongs to browser/emulator evidence.
jest.mock('expo-video', () => ({ VideoView: 'VideoView', useVideoPlayer: jest.fn() }));

describe('Reel source renewal authority', () => {
  afterEach(() => {
    jest.useRealTimers();
  });
  it('never resumes after a hide/restore while grant replacement was pending, and clears source at scope end', async () => {
    jest.useFakeTimers();
    let finishReplacement: (() => void) | undefined;
    let replacements = 0;
    const play = jest.fn();
    const pause = jest.fn();
    const replace = jest.fn(() => {
      replacements += 1;
      return replacements === 2
        ? new Promise<void>((resolve) => {
            finishReplacement = resolve;
          })
        : Promise.resolve();
    });
    const player = {
      currentTime: 5,
      playing: false,
      status: 'readyToPlay',
      playbackRate: 1,
      play,
      pause,
      replaceAsync: replace,
      addListener: () => ({ remove: () => undefined }),
    } as unknown as VideoPlayer;
    jest.mocked(useVideoPlayer).mockReturnValue(player);
    let scopeEnded: (() => void) | undefined;
    const props: ReelPlayerProps = {
      title: 'Fixture Reel',
      durationMs: 30000,
      active: true,
      loadSource: () =>
        Promise.resolve({
          source: { uri: 'https://fixture.invalid/media/fixture' },
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      onSample: () => undefined,
      onDiscontinuity: () => undefined,
      registerEnd: (stop) => {
        scopeEnded = stop;
        return () => undefined;
      },
    };
    const rendered = await renderOn(<ReelPlayer {...props} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    expect(play).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(40000);
      await Promise.resolve();
    });
    expect(replacements).toBe(2);
    await rendered.rerender(<ReelPlayer {...props} active={false} />);
    await rendered.rerender(<ReelPlayer {...props} active />);
    await act(async () => {
      finishReplacement?.();
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(1);
    await act(async () => {
      scopeEnded?.();
      await Promise.resolve();
    });
    expect(replace).toHaveBeenLastCalledWith(null);
    await rendered.unmount();
  });
});

describe('SDK58 web replacement autoplay', () => {
  it('keeps an unplayed source paused and excludes SDK-initiated playback samples', async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const pause = jest.fn();
    const sample = jest.fn();
    const player = {
      currentTime: 0,
      playing: true,
      status: 'readyToPlay',
      playbackRate: 1,
      play: jest.fn(),
      pause,
      replaceAsync: () => {
        // Installed SDK58's web implementation attempts play during replace, even while paused.
        listeners.get('playingChange')?.({ isPlaying: true });
        return Promise.resolve();
      },
      addListener: (kind: string, listener: (payload: unknown) => void) => {
        listeners.set(kind, listener);
        return {
          remove: () => {
            listeners.delete(kind);
          },
        };
      },
    } as unknown as VideoPlayer;
    jest.mocked(useVideoPlayer).mockReturnValue(player);
    const rendered = await renderOn(
      <ReelPlayer
        title="Fixture"
        durationMs={30000}
        active
        loadSource={() => Promise.resolve({ source: null, expiresAt: new Date(Date.now() + 60000).toISOString() })}
        onSample={sample}
        onDiscontinuity={() => undefined}
        registerEnd={() => () => undefined}
      />,
    );
    await act(async () => {
      listeners.get('timeUpdate')?.({ currentTime: 0.25 });
      await Promise.resolve();
    });
    expect(pause).toHaveBeenCalled();
    expect(sample).toHaveBeenCalledWith(expect.objectContaining({ playing: false }));
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    await rendered.unmount();
  });
});
