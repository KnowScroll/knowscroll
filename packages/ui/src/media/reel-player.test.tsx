import { useLayoutEffect } from 'react';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { useVideoPlayer, type VideoPlayer, type VideoSource } from 'expo-video';
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
    const autoplayMuted: boolean[] = [];
    const player = {
      currentTime: 0,
      muted: false,
      playing: true,
      status: 'readyToPlay',
      playbackRate: 1,
      play: jest.fn(),
      pause,
      replaceAsync: () => {
        // Installed SDK58's web implementation attempts play during replace, even while paused.
        autoplayMuted.push(player.muted);
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
    expect(autoplayMuted).toEqual([true]);
    expect(sample).toHaveBeenCalledWith(expect.objectContaining({ playing: false }));
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    await rendered.unmount();
  });
});

// This SDK stand-in intentionally exercises renewal scheduling, not real video decoding.
describe('paused grant renewal', () => {
  it('defers replacement until explicit Play and retains the playback position', async () => {
    jest.useFakeTimers();
    const replace = jest.fn(() => Promise.resolve());
    const play = jest.fn();
    const player = {
      currentTime: 7,
      muted: false,
      playing: false,
      status: 'readyToPlay',
      playbackRate: 1,
      pause: jest.fn(),
      play,
      replaceAsync: replace,
      addListener: () => ({ remove: () => undefined }),
    } as unknown as VideoPlayer;
    jest.mocked(useVideoPlayer).mockReturnValue(player);
    const load = jest.fn(() =>
      Promise.resolve({
        source: { uri: 'https://fixture.invalid/media/fixture' },
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    const rendered = await renderOn(
      <ReelPlayer
        title="Fixture"
        durationMs={30000}
        active
        loadSource={load}
        onSample={() => undefined}
        onDiscontinuity={() => undefined}
        registerEnd={() => () => undefined}
      />,
    );
    await act(async () => {
      jest.advanceTimersByTime(45000);
      await Promise.resolve();
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    expect(replace).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenCalledTimes(1);
    expect(player.currentTime).toBe(7);
    await rendered.unmount();
    jest.useRealTimers();
  });
});

describe('paused loaded-source Retry', () => {
  afterEach(() => {
    jest.useRealTimers();
  });
  it('recovers a grant failure without a duplicate SDK ready event, staying paused until explicit Play', async () => {
    jest.useFakeTimers();
    const listeners = new Map<string, (payload: unknown) => void>();
    const sample = jest.fn();
    let finishRetry: ((grant: { source: { uri: string }; expiresAt: string }) => void) | undefined;
    // Like SDK58 web: replace changes src/playing but never status; an equal canplay status
    // emits nothing. A failed HTTP grant request leaves the existing SDK status readyToPlay.
    const replace = jest.fn((source: VideoSource) => {
      player.src = source;
      player.playing = true;
      return Promise.resolve();
    });
    const play = jest.fn(() => {
      player.playing = true;
      listeners.get('playingChange')?.({ isPlaying: true });
    });
    const player = {
      src: null as VideoSource,
      currentTime: 5,
      muted: false,
      playing: false,
      status: 'readyToPlay',
      playbackRate: 1,
      pause: jest.fn(() => {
        player.playing = false;
      }),
      play,
      replaceAsync: replace,
      addListener: (kind: string, listener: (payload: unknown) => void) => {
        listeners.set(kind, listener);
        return {
          remove: () => {
            listeners.delete(kind);
          },
        };
      },
    };
    jest.mocked(useVideoPlayer).mockReturnValue(player as unknown as VideoPlayer);
    const load = jest.fn(() =>
      Promise.resolve({
        source: { uri: 'https://fixture.invalid/media/fixture' },
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    load.mockImplementationOnce(() =>
      Promise.resolve({
        source: { uri: 'https://fixture.invalid/media/initial' },
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    load.mockRejectedValueOnce(new Error('Fixture grant transport unavailable'));
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRetry = resolve;
        }),
    );
    const rendered = await renderOn(
      <ReelPlayer
        title="Fixture"
        durationMs={30000}
        active
        loadSource={load}
        onSample={sample}
        onDiscontinuity={() => undefined}
        registerEnd={() => () => undefined}
      />,
    );
    await act(async () => {
      jest.advanceTimersByTime(45000);
      await Promise.resolve();
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByText('Playback interrupted')).toBeTruthy();
    expect(player.status).toBe('readyToPlay');
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByText('Playback interrupted')).toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
    await act(async () => {
      finishRetry?.({
        source: { uri: 'https://fixture.invalid/media/retry' },
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
      await Promise.resolve();
    });
    // Scope/effect cleanup clears the old source before the retry installs the fresh one.
    expect(replace).toHaveBeenCalledTimes(3);
    expect(player.src).toEqual({ uri: 'https://fixture.invalid/media/retry' });
    expect(screen.queryByText('Playback interrupted')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(player.playing).toBe(false);
    expect(play).not.toHaveBeenCalled();
    await act(async () => {
      listeners.get('timeUpdate')?.({ currentTime: 5 });
      await Promise.resolve();
    });
    expect(sample).toHaveBeenLastCalledWith(expect.objectContaining({ playing: false }));
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    await act(async () => {
      listeners.get('timeUpdate')?.({ currentTime: 5.25 });
      await Promise.resolve();
    });
    expect(sample).toHaveBeenLastCalledWith(expect.objectContaining({ playing: true }));
    // A genuine later SDK error must still surface even after the snapshot reconciled ready.
    await act(async () => {
      player.status = 'error';
      listeners.get('statusChange')?.({ status: 'error' });
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByText('Playback interrupted')).toBeTruthy();
    await rendered.unmount();
  });

  it.each(['error', 'loading'] as const)(
    'keeps the committed SDK %s state instead of assuming replace success means ready',
    async (sdkStatus) => {
      const play = jest.fn();
      const player = {
        currentTime: 0,
        muted: false,
        playing: false,
        status: sdkStatus,
        playbackRate: 1,
        pause: jest.fn(),
        play,
        replaceAsync: () => Promise.resolve(),
        addListener: () => ({ remove: () => undefined }),
      } as unknown as VideoPlayer;
      jest.mocked(useVideoPlayer).mockReturnValue(player);
      const rendered = await renderOn(
        <ReelPlayer
          title="Fixture"
          durationMs={30000}
          active
          loadSource={() => Promise.resolve({ source: null, expiresAt: new Date(Date.now() + 60000).toISOString() })}
          onSample={() => undefined}
          onDiscontinuity={() => undefined}
          registerEnd={() => () => undefined}
        />,
      );
      expect(screen.getByText(sdkStatus === 'error' ? 'Playback interrupted' : 'Fixture')).toBeTruthy();
      if (sdkStatus === 'error') {
        await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
      }
      expect(play).not.toHaveBeenCalled();
      await rendered.unmount();
    },
  );
});

// Stand-in for VideoView committing its new src after replaceAsync has resolved.
describe('source commit and resume ordering', () => {
  it.each(['ended', 'released'] as const)('fences an %s source before post-commit reconciliation', async (ending) => {
    let scopeEnded: (() => void) | undefined;
    let released = false;
    let statusReads = 0;
    const player = {
      src: null as VideoSource,
      currentTime: 0,
      muted: false,
      playing: false,
      get status() {
        statusReads += 1;
        if (released) throw new Error('Fixture SharedObject released');
        return 'readyToPlay';
      },
      playbackRate: 1,
      pause: jest.fn(),
      play: jest.fn(),
      replaceAsync: (source: VideoSource) => {
        player.src = source;
        return Promise.resolve();
      },
      addListener: () => ({ remove: () => undefined }),
    };
    function useStandInPlayer() {
      const source = player.src;
      useLayoutEffect(() => {
        if (!source) return;
        // The child source commit can coincide with scope teardown or native SDK release.
        if (ending === 'ended') scopeEnded?.();
        else released = true;
      }, [source]);
      return player as unknown as VideoPlayer;
    }
    jest.mocked(useVideoPlayer).mockImplementation(useStandInPlayer);
    const rendered = await renderOn(
      <ReelPlayer
        title="Fixture"
        durationMs={30000}
        active
        loadSource={() =>
          Promise.resolve({
            source: { uri: 'https://fixture.invalid/media/fixture' },
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          })
        }
        onSample={() => undefined}
        onDiscontinuity={() => undefined}
        registerEnd={(stop) => {
          scopeEnded = stop;
          return () => undefined;
        }}
      />,
    );
    expect(player.play).not.toHaveBeenCalled();
    if (ending === 'ended') {
      expect(player.src).toBeNull();
      expect(statusReads).toBe(0);
      expect(screen.queryByText('Playback interrupted')).toBeNull();
    } else {
      expect(screen.getByText('Playback interrupted')).toBeTruthy();
    }
    await rendered.unmount();
  });

  it('resumes only after the rendered source commit that resets HTML playback', async () => {
    jest.useFakeTimers();
    const player = {
      src: null as VideoSource,
      currentTime: 7,
      muted: false,
      playing: false,
      status: 'readyToPlay',
      playbackRate: 1,
      pause: () => {
        player.playing = false;
      },
      play: () => {
        player.playing = true;
      },
      replaceAsync: (source: VideoSource) => {
        player.src = source;
        return Promise.resolve();
      },
      addListener: () => ({ remove: () => undefined }),
    };
    function useStandInPlayer() {
      const source = player.src;
      useLayoutEffect(() => {
        if (source) player.pause();
      }, [source]);
      return player as unknown as VideoPlayer;
    }
    jest.mocked(useVideoPlayer).mockImplementation(useStandInPlayer);
    const rendered = await renderOn(
      <ReelPlayer
        title="Fixture"
        durationMs={30000}
        active
        loadSource={() =>
          Promise.resolve({
            source: { uri: 'https://fixture.invalid/media/fixture' },
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          })
        }
        onSample={() => undefined}
        onDiscontinuity={() => undefined}
        registerEnd={() => () => undefined}
      />,
    );
    await act(async () => {
      jest.advanceTimersByTime(45000);
      await Promise.resolve();
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    expect(player.playing).toBe(true);
    expect(player.currentTime).toBe(7);
    await rendered.unmount();
    jest.useRealTimers();
  });
});
