import { Text, View } from 'react-native';
import { createRef, useLayoutEffect } from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { useVideoPlayer, type VideoPlayer, type VideoSource } from 'expo-video';
import { focusRing } from '@knowscroll/design-tokens';
import { expectPressed, renderOn } from '../test-support/render';
import { DisplayProvider } from '../display/display';
import { ReelPlayer, type ReelPlayerProps, type ReelPositionHandle } from './reel-player';
import { ReelProgress } from './reel-progress';

/** The player with the progress row and sound switch the screens draw over it. */
function WithSound(props: ReelPlayerProps) {
  return (
    <ReelPlayer {...props}>
      {(playback) => (
        <ReelProgress
          positionMs={playback.positionMs}
          durationMs={playback.durationMs}
          muted={playback.muted}
          onToggleMuted={playback.toggleMuted}
        />
      )}
    </ReelPlayer>
  );
}

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
    expect(screen.getByText(/Playback interrupted/)).toBeTruthy();
    expect(player.status).toBe('readyToPlay');
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByText(/Playback interrupted/)).toBeNull();
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
    expect(screen.queryByText(/Playback interrupted/)).toBeNull();
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
    expect(screen.getByText(/Playback interrupted/)).toBeTruthy();
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
      if (sdkStatus === 'error') expect(screen.getByText(/Playback interrupted/)).toBeTruthy();
      else expect(screen.queryByText(/Playback interrupted/)).toBeNull();
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
      expect(screen.queryByText(/Playback interrupted/)).toBeNull();
    } else {
      expect(screen.getByText(/Playback interrupted/)).toBeTruthy();
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

// Private local position contract: SDK snapshots, not recorder samples or grants.
describe('local Reel positions', () => {
  afterEach(() => jest.useRealTimers());

  function fixture() {
    const listeners = new Map<string, (payload: unknown) => void>();
    let seconds = 0;
    let released = false;
    const reads = jest.fn();
    const seeks = jest.fn();
    const player = {
      get currentTime() {
        reads();
        if (released) throw new Error('Fixture SharedObject released');
        return seconds;
      },
      set currentTime(value: number) {
        seeks(value);
        if (released) throw new Error('Fixture SharedObject released');
        seconds = value;
      },
      muted: false,
      playing: false,
      status: 'readyToPlay' as VideoPlayer['status'],
      playbackRate: 1,
      pause: jest.fn(() => {
        player.playing = false;
      }),
      play: jest.fn(() => {
        player.playing = true;
        listeners.get('playingChange')?.({ isPlaying: true });
      }),
      replaceAsync: jest.fn((_source: VideoSource) => {
        // Replacing a real video resets its playhead and SDK58 web attempts autoplay.
        seconds = 0;
        player.playing = true;
        return Promise.resolve();
      }),
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
    let scopeEnd: (() => void) | undefined;
    const positionRef = createRef<ReelPositionHandle>();
    const props: ReelPlayerProps = {
      title: 'Local position fixture',
      durationMs: 30000,
      active: true,
      positionRef,
      loadSource: jest.fn(() =>
        Promise.resolve({
          source: { uri: 'https://fixture.invalid/media/local' },
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      ),
      onSample: jest.fn(),
      onDiscontinuity: jest.fn(),
      registerEnd: (stop) => {
        scopeEnd = stop;
        return () => undefined;
      },
    };
    return {
      player,
      props,
      positionRef,
      listeners,
      reads,
      seeks,
      advanceSdk: (time: number) => {
        seconds = time;
      },
      release: () => {
        released = true;
      },
      endScope: () => scopeEnd?.(),
    };
  }

  it('captures the current SDK time ahead of timeUpdate and parks without adding samples', async () => {
    const f = fixture();
    const rendered = await renderOn(<ReelPlayer {...f.props} initialPositionMs={4000} />);
    await act(async () => {
      f.listeners.get('timeUpdate')?.({ currentTime: 4 });
      await Promise.resolve();
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    f.advanceSdk(4.1875); // no timeUpdate: parking must read the SDK synchronously.
    expect(f.positionRef.current?.capture()).toEqual({ positionMs: 4187.5, playing: true, muted: false });
    const samples = jest.mocked(f.props.onSample).mock.calls.length;
    await act(() => {
      f.positionRef.current?.pause();
      f.positionRef.current?.pause();
    });
    expect(f.player.playing).toBe(false);
    expect(f.positionRef.current?.capture()).toEqual({ positionMs: 4187.5, playing: false, muted: false });
    expect(f.props.onSample).toHaveBeenCalledTimes(samples);
    f.advanceSdk(35);
    expect(f.positionRef.current?.capture()?.positionMs).toBe(30000);
    f.advanceSdk(-1);
    expect(f.positionRef.current?.capture()?.positionMs).toBe(0);
    f.advanceSdk(NaN);
    expect(f.positionRef.current?.capture()).toBeNull();
    f.release();
    expect(f.positionRef.current?.capture()).toBeNull();
    await rendered.unmount();
    expect(f.positionRef.current).toBeNull();
  });

  it.each([
    [undefined, 0],
    [NaN, 0],
    [Infinity, 0],
    [-Infinity, 0],
    [-10, 0],
    [45000, 30000],
    [1234.5, 1234.5],
  ])('validates initialPositionMs %s to %s and does not reapply changed props', async (initialPositionMs, expected) => {
    const f = fixture();
    const rendered = await renderOn(<ReelPlayer {...f.props} initialPositionMs={initialPositionMs} />);
    expect(f.positionRef.current?.capture()).toEqual({ positionMs: expected, playing: false, muted: false });
    expect(f.player.play).not.toHaveBeenCalled();
    f.advanceSdk(6.25);
    await rendered.rerender(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ReelPlayer {...f.props} initialPositionMs={9000} />
      </DisplayProvider>,
    );
    expect(f.positionRef.current?.capture()?.positionMs).toBe(6250);
    await rendered.unmount();
  });

  it('waits for SDK readiness before restoring once, paused, after source commit', async () => {
    const f = fixture();
    f.player.status = 'loading';
    const rendered = await renderOn(<ReelPlayer {...f.props} initialPositionMs={8125} />);
    expect(f.seeks).not.toHaveBeenCalled();
    expect(f.positionRef.current?.capture()).toBeNull();
    await act(async () => {
      f.player.status = 'readyToPlay';
      f.listeners.get('statusChange')?.({ status: 'readyToPlay' });
      await Promise.resolve();
    });
    expect(f.seeks).toHaveBeenCalledTimes(1);
    expect(f.positionRef.current?.capture()).toEqual({ positionMs: 8125, playing: false, muted: false });
    await act(async () => {
      f.listeners.get('statusChange')?.({ status: 'readyToPlay' });
      await Promise.resolve();
    });
    expect(f.seeks).toHaveBeenCalledTimes(1);
    expect(f.player.play).not.toHaveBeenCalled();
    await rendered.unmount();
  });

  it('plays on once its source is restored when a sheet it was playing under has closed, and only then', async () => {
    const f = fixture();
    f.player.status = 'loading';
    const rendered = await renderOn(<ReelPlayer {...f.props} initialPositionMs={8125} initialPlaying />);
    expect(f.player.play).not.toHaveBeenCalled();
    await act(async () => {
      f.player.status = 'readyToPlay';
      f.listeners.get('statusChange')?.({ status: 'readyToPlay' });
      await Promise.resolve();
    });
    expect(f.seeks).toHaveBeenCalledWith(8.125);
    expect(f.player.play).toHaveBeenCalledTimes(1);
    await rendered.unmount();
  });

  it('retains the initial restore intent when Retry happens before the SDK has ever been ready', async () => {
    const f = fixture();
    f.player.status = 'loading';
    const rendered = await renderOn(<ReelPlayer {...f.props} initialPositionMs={8125} />);
    await act(async () => {
      f.player.status = 'error';
      f.listeners.get('statusChange')?.({ status: 'error' });
      await Promise.resolve();
    });
    f.player.status = 'loading';
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(f.seeks).not.toHaveBeenCalled();
    await act(async () => {
      f.player.status = 'readyToPlay';
      f.listeners.get('statusChange')?.({ status: 'readyToPlay' });
      await Promise.resolve();
    });
    expect(f.positionRef.current?.capture()).toEqual({ positionMs: 8125, playing: false, muted: false });
    expect(f.player.play).not.toHaveBeenCalled();
    await rendered.unmount();
  });

  it('renews and retries at the latest SDK position, including a backward move, rather than the initial position', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const rendered = await renderOn(<ReelPlayer {...f.props} initialPositionMs={4000} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    f.advanceSdk(14.125);
    await act(async () => {
      jest.advanceTimersByTime(40000);
      await Promise.resolve();
    });
    expect(f.player.currentTime).toBe(14.125);
    f.advanceSdk(9.25); // newer actual position is earlier; Math.max would lose this move.
    await act(async () => {
      f.player.status = 'error';
      f.listeners.get('statusChange')?.({ status: 'error' });
      await Promise.resolve();
    });
    f.player.status = 'readyToPlay';
    const plays = f.player.play.mock.calls.length;
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(f.player.currentTime).toBe(9.25);
    expect(f.positionRef.current?.capture()).toEqual({ positionMs: 9250, playing: false, muted: false });
    expect(f.player.play).toHaveBeenCalledTimes(plays);
    await rendered.unmount();
  });

  it.each(['scope', 'unmount'] as const)(
    'clears the ref and fences retained methods and late replacement after %s disposal',
    async (ending) => {
      const f = fixture();
      let settle: (() => void) | undefined;
      f.player.replaceAsync.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      );
      const rendered = await renderOn(<ReelPlayer {...f.props} initialPositionMs={5000} />);
      const handle = f.positionRef.current;
      expect(handle).not.toBeNull();
      expect(handle?.capture()).toBeNull();
      if (ending === 'scope') await act(() => f.endScope());
      else await rendered.unmount();
      expect(f.positionRef.current).toBeNull();
      const reads = f.reads.mock.calls.length;
      const pauses = f.player.pause.mock.calls.length;
      const seeks = f.seeks.mock.calls.length;
      f.release();
      await act(() => {
        handle?.pause();
      });
      expect(handle?.capture()).toBeNull();
      await act(async () => {
        settle?.();
        await Promise.resolve();
      });
      expect(f.reads).toHaveBeenCalledTimes(reads);
      expect(f.player.pause).toHaveBeenCalledTimes(pauses);
      expect(f.seeks).toHaveBeenCalledTimes(seeks);
      expect(f.player.play).not.toHaveBeenCalled();
      if (ending === 'scope') {
        await rendered.rerender(
          <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
            <ReelPlayer {...f.props} active={false} initialPositionMs={12000} />
          </DisplayProvider>,
        );
        expect(f.positionRef.current).toBeNull();
        await rendered.unmount();
      }
    },
  );
});

describe('Reel stage wrapper', () => {
  it('wraps the video and its play surface while the chrome stays outside, retaining the same player/source on rerender', async () => {
    const play = jest.fn();
    const replaceAsync = jest.fn(() => Promise.resolve());
    const player = {
      currentTime: 0,
      playing: false,
      status: 'readyToPlay',
      playbackRate: 1,
      play,
      pause: jest.fn(),
      replaceAsync,
      addListener: () => ({ remove: () => undefined }),
    } as unknown as VideoPlayer;
    jest.mocked(useVideoPlayer).mockReturnValue(player);
    const positionRef = createRef<ReelPositionHandle>();
    const loadSource = jest.fn(() =>
      Promise.resolve({
        source: { uri: 'https://fixture.invalid/media/stage-fixture' },
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      }),
    );
    const props: ReelPlayerProps = {
      title: 'Stage fixture Reel',
      durationMs: 30000,
      active: true,
      positionRef,
      loadSource,
      onSample: jest.fn(),
      onDiscontinuity: jest.fn(),
      registerEnd: () => () => undefined,
    };
    const element = (
      <ReelPlayer {...props} renderStage={(stage) => <View testID="fixture-stage-wrapper">{stage}</View>}>
        <View testID="fixture-chrome">
          <Text>Chrome</Text>
        </View>
      </ReelPlayer>
    );
    const rendered = await renderOn(element);
    const stage = screen.getByTestId('fixture-stage-wrapper');
    expect(within(stage).getByLabelText('Stage fixture Reel')).toBeTruthy();
    // The play surface is the stage's only control; the chrome is a sibling of the stage.
    expect(within(stage).getAllByRole('button')).toHaveLength(1);
    expect(within(stage).queryByText('Chrome')).toBeNull();
    expect(within(screen.getByTestId('fixture-chrome')).getByText('Chrome')).toBeTruthy();
    expect(within(screen.getByTestId('reel-video-stage')).queryByText('Chrome')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    expect(play).toHaveBeenCalledTimes(1);
    player.currentTime = 3.25;
    expect(positionRef.current?.capture()?.positionMs).toBe(3250);
    await rendered.rerender(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{element}</DisplayProvider>,
    );
    expect(loadSource).toHaveBeenCalledTimes(1);
    expect(replaceAsync).toHaveBeenCalledTimes(1);
    expect(positionRef.current?.capture()?.positionMs).toBe(3250);
    await rendered.unmount();
  });
});

// Labelled SDK fixtures: audio intent and teardown ordering, never actual decoding or playback.
describe('explicit Reel sound controls', () => {
  afterEach(() => jest.useRealTimers());
  function fixture() {
    let soundMuted = false;
    let replacementCount = 0;
    let finish: ((fail?: boolean) => void) | undefined;
    let scopeEnd: (() => void) | undefined;
    const writes: { muted: boolean; playing: boolean }[] = [];
    const autoplayMuted: boolean[] = [];
    const listeners = new Map<string, (payload: unknown) => void>();
    const player = {
      currentTime: 4,
      get muted() {
        return soundMuted;
      },
      set muted(value: boolean) {
        writes.push({ muted: value, playing: player.playing });
        soundMuted = value;
      },
      playing: false,
      status: 'readyToPlay' as VideoPlayer['status'],
      playbackRate: 1,
      play: jest.fn(() => {
        player.playing = true;
        listeners.get('playingChange')?.({ isPlaying: true });
      }),
      pause: jest.fn(() => {
        player.playing = false;
      }),
      replaceAsync: jest.fn((source: VideoSource) => {
        if (source === null) {
          player.playing = false;
          return Promise.resolve();
        }
        replacementCount += 1;
        autoplayMuted.push(soundMuted);
        player.playing = true; // SDK58 web's internal replacement autoplay.
        return replacementCount === 2
          ? new Promise<void>((resolve, reject) => {
              finish = (fail) => {
                if (fail) {
                  player.playing = true; // A failing SDK can still report playback during settlement.
                  reject(new Error('CI replacement failure'));
                } else resolve();
              };
            })
          : Promise.resolve();
      }),
      addListener: (kind: string, callback: (payload: unknown) => void) => {
        listeners.set(kind, callback);
        return {
          remove: () => {
            listeners.delete(kind);
          },
        };
      },
    };
    jest.mocked(useVideoPlayer).mockReturnValue(player as unknown as VideoPlayer);
    const props: ReelPlayerProps = {
      title: 'Sound control fixture',
      durationMs: 30000,
      active: true,
      loadSource: jest.fn(() =>
        Promise.resolve({
          source: { uri: 'https://fixture.invalid/media/sound' },
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      ),
      onMutedChange: jest.fn(),
      onSample: jest.fn(),
      onDiscontinuity: jest.fn(),
      registerEnd: (stop) => {
        scopeEnd = stop;
        return () => undefined;
      },
    };
    return { player, props, writes, autoplayMuted, finish: (fail = false) => finish?.(fail), end: () => scopeEnd?.() };
  }
  it('offers an accessible phone-sized sound toggle without playback, source or recording effects', async () => {
    const f = fixture();
    const app = await renderOn(<WithSound {...f.props} />, { width: 320, textScale: 2 });
    const sources = f.player.replaceAsync.mock.calls.length;
    const discontinuities = jest.mocked(f.props.onDiscontinuity).mock.calls.length;
    for (const label of ['Play', 'Mute']) {
      const control = screen.getByRole(label === 'Mute' ? 'togglebutton' : 'button', { name: label });
      await fireEvent(control, 'focus');
      expect(control).toHaveStyle({ outlineColor: focusRing.onDark.color });
      await fireEvent(control, 'blur');
      expect(control).not.toHaveStyle({ outlineColor: focusRing.onDark.color });
    }
    expectPressed(screen.getByRole('togglebutton', { name: 'Mute' }), false);
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Mute' }));
    expectPressed(screen.getByRole('togglebutton', { name: 'Unmute' }), true);
    expect(f.player.muted).toBe(true);
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Unmute' }));
    expectPressed(screen.getByRole('togglebutton', { name: 'Mute' }), false);
    expect(f.player.muted).toBe(false);
    expect(f.props.onMutedChange).toHaveBeenNthCalledWith(1, true);
    expect(f.props.onMutedChange).toHaveBeenNthCalledWith(2, false);
    expect(f.player.play).not.toHaveBeenCalled();
    expect(f.player.currentTime).toBe(4);
    expect(f.player.replaceAsync).toHaveBeenCalledTimes(sources);
    expect(f.props.onSample).not.toHaveBeenCalled();
    expect(f.props.onDiscontinuity).toHaveBeenCalledTimes(discontinuities);
    await app.unmount();
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'restores latest intent after pending replacement (initial muted=%s, SDK fails=%s)',
    async (initialMuted, fails) => {
      jest.useFakeTimers();
      const f = fixture();
      const app = await renderOn(<WithSound {...f.props} initialMuted={initialMuted} />);
      await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
      await act(async () => {
        jest.advanceTimersByTime(40000);
        await Promise.resolve();
      });
      expect(f.player.replaceAsync).toHaveBeenCalledTimes(2);
      await fireEvent.press(screen.getByRole('togglebutton', { name: initialMuted ? 'Unmute' : 'Mute' }));
      expect(f.player.muted).toBe(true); // Safety mute remains until replacement is paused.
      expect(f.props.onMutedChange).toHaveBeenLastCalledWith(!initialMuted);
      await act(async () => {
        f.finish(fails);
        await Promise.resolve();
      });
      expect(f.player.muted).toBe(!initialMuted);
      expect(f.autoplayMuted).toEqual([true, true]);
      expect(f.writes.filter((write) => !write.muted && write.playing)).toEqual([]);
      expect(f.player.currentTime).toBe(4);
      await app.unmount();
    },
  );
  it('never unmutes or resumes from a late replacement after scope disposal, and a new player starts independently', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const app = await renderOn(<WithSound {...f.props} initialMuted />);
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    await act(async () => {
      jest.advanceTimersByTime(40000);
      await Promise.resolve();
    });
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Unmute' }));
    await act(async () => {
      f.end();
      await Promise.resolve();
    });
    const writes = f.writes.length,
      plays = f.player.play.mock.calls.length;
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Mute' }));
    await act(async () => {
      f.finish();
      await Promise.resolve();
    });
    expect(f.writes).toHaveLength(writes);
    expect(f.player.play).toHaveBeenCalledTimes(plays);
    expect(f.player.muted).toBe(true);
    expect(f.autoplayMuted).toEqual([true, true]);
    expect(f.player.replaceAsync).toHaveBeenLastCalledWith(null);
    await app.unmount();
    const next = fixture();
    const nextApp = await renderOn(<WithSound {...next.props} />);
    expectPressed(screen.getByRole('togglebutton', { name: 'Mute' }), false);
    expect(next.player.muted).toBe(false);
    expect(next.player.play).not.toHaveBeenCalled();
    await nextApp.unmount();
  });
});
