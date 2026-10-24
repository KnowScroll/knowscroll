import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type Ref,
} from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { VideoView, useVideoPlayer, type VideoSource, type VideoPlayer } from 'expo-video';
import { content, overlay, spacing } from '@knowscroll/design-tokens';
import { Text } from '../text/text';
import { useFocusRing } from '../display/focus-ring';
import { Icon } from '../icons/icon';
import { Spinner } from '../feedback/spinner';
import { observeMediaVisibility } from './visibility';

// expo-video exposes seeking as an imperative native SDK property.
function pausePlayback(player: VideoPlayer): void {
  try {
    player.pause();
  } catch {
    /* expo-video already released the native SharedObject. */
  }
}
function seekPlayback(player: VideoPlayer, time: number): void {
  player.currentTime = time;
}
function mutePlayback(player: VideoPlayer, muted: boolean): void {
  player.muted = muted;
}
function clampPositionMs(positionMs: number, durationMs: number): number {
  return Number.isFinite(positionMs)
    ? Math.max(0, Math.min(positionMs, Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0))
    : 0;
}
function setPositionRef(ref: Ref<ReelPositionHandle> | undefined, value: ReelPositionHandle | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}
/** Private local state only. The AccountScope consumer binds asset/revision and owns purge. */
export interface ReelLocalPosition {
  readonly positionMs: number;
  readonly playing: boolean;
  readonly muted: boolean;
}
export interface ReelPositionHandle {
  /** Synchronous SDK snapshot; null while unavailable, replacing, or released. */
  capture(): ReelLocalPosition | null;
  /** Park immediately without emitting a sample or granting future playback intent. */
  pause(): void;
}
export type ReelPlaybackStatus = 'loading' | 'ready' | 'buffering' | 'error';
type PlaybackStatus = ReelPlaybackStatus;
function playbackStatus(status: VideoPlayer['status'], playing: boolean): PlaybackStatus {
  return status === 'error' ? 'error' : status === 'readyToPlay' ? 'ready' : playing ? 'buffering' : 'loading';
}

/** What the screen needs to draw the progress row and sound control over the video. */
/** Playback commands for a screen that draws its own compact controls (a thread's inline player). */
export interface ReelControls {
  /** Play, pause, or Retry after a failure: exactly what tapping the stage does. */
  toggle(): void;
  /** Move the playhead by this many seconds, clamped to the Reel. */
  seekBy(seconds: number): void;
}

export interface ReelPlaybackView {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly playing: boolean;
  readonly status: ReelPlaybackStatus;
  readonly muted: boolean;
  /** Explicit sound choice; never starts or resumes playback. */
  readonly toggleMuted: () => void;
}

export interface ReelPlayerProps {
  readonly title: string;
  /** Screen chrome drawn over the full-bleed stage (top bar, actions, title, progress). It sits
   * outside the stage wrapper, so it never takes part in the stage's swipe arbitration. */
  readonly children?: ReactNode | ((playback: ReelPlaybackView) => ReactNode);
  readonly durationMs: number;
  readonly active: boolean;
  /** Mount-only restore intent in milliseconds. Non-finite values become zero. */
  readonly initialPositionMs?: number;
  /**
   * Mount-only: the Reel was playing under a sheet that has just closed, so it plays on once its
   * source is ready and the stage is visible. Never set for a return from anywhere else (D-006 k).
   */
  readonly initialPlaying?: boolean;
  /** Mount-only sound preference; the encounter owner retains it only for that entry. */
  readonly initialMuted?: boolean;
  /** Explicit sound changes only; never called for the temporary source-replacement mute. */
  readonly onMutedChange?: (muted: boolean) => void;
  readonly positionRef?: Ref<ReelPositionHandle>;
  /** For screens that draw their own play, seek and sound controls. */
  readonly controlsRef?: Ref<ReelControls>;
  /** The whole stage is one play/pause button by default; false leaves the controls to the screen. */
  readonly tapToToggle?: boolean;
  /** Wrap only the noninteractive video/poster stage. Playback controls remain outside.
   * Return a flex-filling element and preserve the supplied stage; own gesture policy in the app.
   */
  readonly renderStage?: (stage: ReactNode) => ReactNode;
  readonly loadSource: () => Promise<{ readonly source: VideoSource; readonly expiresAt: string }>;
  readonly onSample: (sample: {
    positionMs: number;
    monotonicMs: number;
    playing: boolean;
    visible: boolean;
    buffering: boolean;
  }) => void;
  readonly onDiscontinuity: () => void;
  readonly registerEnd: (stop: () => void) => () => void;
}
/** Draws the screen's chrome from the current playback view. */
function PlaybackSlot({
  playback,
  children,
}: {
  readonly playback: ReelPlaybackView;
  readonly children: ReelPlayerProps['children'];
}) {
  return typeof children === 'function' ? children(playback) : (children ?? null);
}

/** The same expo-video player on native and web; web cookies and native headers are supplied by
 * AccountScope. A grant renews before expiry without opening/activating another exposure. */
export function ReelPlayer({
  title,
  children,
  durationMs,
  active,
  initialPositionMs,
  initialMuted,
  initialPlaying,
  onMutedChange,
  positionRef,
  controlsRef,
  tapToToggle = true,
  renderStage,
  loadSource,
  onSample,
  onDiscontinuity,
  registerEnd,
}: ReelPlayerProps) {
  const [muted, setMuted] = useState(initialMuted === true);
  const muteIntent = useRef(initialMuted === true);
  const player = useVideoPlayer(null, (instance) => {
    instance.loop = false;
    instance.muted = muted;
    instance.timeUpdateEventInterval = 0.25;
    instance.staysActiveInBackground = false;
    instance.allowsExternalPlayback = false;
  });
  const view = useRef<ComponentRef<typeof View>>(null);
  const visible = useRef(false);
  const activeRef = useRef(active);
  const [initialPosition] = useState(() => ({
    supplied: initialPositionMs !== undefined,
    seconds: clampPositionMs(initialPositionMs ?? 0, durationMs) / 1000,
  }));
  const resumePosition = useRef(initialPosition.seconds);
  const ended = useRef(false);
  const hasSource = useRef(false);
  const clearPositionRef = useRef<() => void>(() => undefined);
  const playbackIntent = useRef(initialPlaying === true);
  const replacing = useRef(false);
  const needsRefresh = useRef(true);
  const loaded = useRef(false);
  const refreshSource = useRef<() => Promise<void>>(() => Promise.resolve());
  const [status, setStatus] = useState<PlaybackStatus>('loading');
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(initialPosition.seconds);
  const [attempt, setAttempt] = useState(0);
  const [sourceRevision, setSourceRevision] = useState(0);
  const installedSource = useRef<{
    position: number;
    committed: boolean;
    restored: boolean;
    isCurrent: () => boolean;
  } | null>(null);

  useLayoutEffect(() => {
    ended.current = false;
    return () => {
      ended.current = true;
      clearPositionRef.current();
    };
  }, [player]);
  useLayoutEffect(() => {
    const handle: ReelPositionHandle = {
      capture: () => {
        if (ended.current || replacing.current || !hasSource.current || !installedSource.current?.restored) return null;
        try {
          const seconds = player.currentTime;
          if (!Number.isFinite(seconds)) return null;
          return {
            positionMs: clampPositionMs(seconds * 1000, durationMs),
            playing: player.playing,
            muted: muteIntent.current,
          };
        } catch {
          // Native SharedObjects can be released before React runs our cleanup.
          return null;
        }
      },
      pause: () => {
        if (ended.current) return;
        const interrupted = playbackIntent.current;
        playbackIntent.current = false;
        pausePlayback(player);
        setPlaying(false);
        if (interrupted) onDiscontinuity();
      },
    };
    const clear = () => setPositionRef(positionRef, null);
    clearPositionRef.current = clear;
    if (!ended.current) setPositionRef(positionRef, handle);
    return clear;
  }, [player, positionRef, durationMs, onDiscontinuity]);
  const restoreInstalledPosition = useCallback(
    (sdkStatus: VideoPlayer['status']) => {
      const installed = installedSource.current;
      if (
        ended.current ||
        !installed?.isCurrent() ||
        !installed.committed ||
        installed.restored ||
        sdkStatus !== 'readyToPlay'
      )
        return;
      try {
        seekPlayback(player, installed.position);
        resumePosition.current = installed.position;
        setPosition(installed.position);
        installed.restored = true;
        if (playbackIntent.current && activeRef.current && visible.current) player.play();
      } catch {
        pausePlayback(player);
        onDiscontinuity();
        setStatus('error');
      }
    },
    [player, onDiscontinuity],
  );

  useEffect(
    () =>
      observeMediaVisibility(view.current, (value) => {
        if (ended.current) return;
        visible.current = value;
        // A resume owed from a closed sheet starts once the stage is both visible and restored.
        if (value && playbackIntent.current && activeRef.current && installedSource.current?.restored) player.play();
        if (!value) {
          playbackIntent.current = false;
          pausePlayback(player);
          onDiscontinuity();
        }
      }),
    [player, onDiscontinuity],
  );
  useEffect(() => {
    activeRef.current = active;
    if (ended.current) return;
    if (!active) {
      playbackIntent.current = false;
      pausePlayback(player);
      onDiscontinuity();
    }
  }, [active, player, onDiscontinuity]);
  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (disposed) return;
      disposed = true;
      playbackIntent.current = false;
      if (timer) clearTimeout(timer);
      onDiscontinuity();
      // The hook also releases its native SharedObject on unmount; either cleanup order is safe.
      try {
        if (hasSource.current && installedSource.current?.restored && !replacing.current) {
          const seconds = player.currentTime;
          if (Number.isFinite(seconds)) resumePosition.current = clampPositionMs(seconds * 1000, durationMs) / 1000;
        }
        hasSource.current = false;
        pausePlayback(player);
        void player.replaceAsync(null).catch(() => undefined);
      } catch {
        /* Already released by expo-video. */
      }
    };
    const unregister = registerEnd(() => {
      ended.current = true;
      clearPositionRef.current();
      stop();
    });
    const refresh = async (allowPaused = false) => {
      if (disposed || ended.current || refreshing) return;
      // Buffered media can remain paused past grant expiry. Obtain a fresh grant only on
      // explicit Play; SDK58 source replacement itself tries autoplay on web.
      if (loaded.current && !allowPaused && (!playbackIntent.current || !activeRef.current || !visible.current)) {
        needsRefresh.current = true;
        return;
      }
      refreshing = true;
      setStatus('loading');
      try {
        const grant = await loadSource();
        if (disposed || ended.current) return;
        if (loaded.current && !allowPaused && (!playbackIntent.current || !activeRef.current || !visible.current)) {
          needsRefresh.current = true;
          return;
        }
        const actualTime = player.currentTime;
        const time =
          (hasSource.current && installedSource.current?.restored) || (!loaded.current && !initialPosition.supplied)
            ? Number.isFinite(actualTime)
              ? clampPositionMs(actualTime * 1000, durationMs) / 1000
              : resumePosition.current
            : resumePosition.current;
        resumePosition.current = time;
        replacing.current = true;
        pausePlayback(player);
        onDiscontinuity();
        player.muted = true;
        try {
          const pending = player.replaceAsync(grant.source);
          // Web replaceAsync calls HTMLVideoElement.play synchronously. Cancel it in this
          // same JS turn, before its asynchronous playback task, with audio already muted.
          pausePlayback(player);
          await pending;
          if (!disposed && !ended.current) pausePlayback(player);
        } finally {
          if (!disposed && !ended.current) {
            // Even a rejected replacement must stop before explicit sound intent is restored.
            pausePlayback(player);
            player.muted = muteIntent.current;
          }
        }
        if (disposed || ended.current) return;
        // SDK58's web replaceAsync starts the HTML video itself. Fence that internal autoplay:
        // every replacement is paused first, and only current explicit intent can resume it.
        pausePlayback(player);
        setPlaying(false);
        installedSource.current = {
          position: time,
          committed: false,
          restored: false,
          isCurrent: () => !disposed && !ended.current,
        };
        hasSource.current = true;
        replacing.current = false;
        loaded.current = true;
        needsRefresh.current = false;
        // VideoView renders player.src. Let React commit that source before imperative seek/play;
        // otherwise its later src commit resets the HTML video after we have already resumed.
        setSourceRevision((value) => value + 1);
        timer = setTimeout(
          () => {
            void refresh();
          },
          Math.max(1000, Math.min(40000, Date.parse(grant.expiresAt) - Date.now() - 15000)),
        );
      } catch {
        if (!disposed && !ended.current) {
          pausePlayback(player);
          onDiscontinuity();
          setStatus('error');
        }
      } finally {
        refreshing = false;
        if (!disposed && !ended.current) replacing.current = false;
      }
    };
    refreshSource.current = () => refresh();
    void refresh(true);
    return () => {
      unregister();
      stop();
    };
  }, [player, loadSource, registerEnd, onDiscontinuity, attempt, durationMs, initialPosition]);
  useEffect(() => {
    const installed = installedSource.current;
    if (sourceRevision === 0 || !installed?.isCurrent()) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled || !installed.isCurrent()) return;
      try {
        // SDK58 web replacement does not reset status. If a grant request failed while the SDK
        // stayed ready, canplay sets the same status and emits no statusChange. Reconcile the
        // actual SDK status after VideoView commits the source; settlement alone is not readiness.
        const sdkStatus = player.status;
        setStatus(playbackStatus(sdkStatus, player.playing));
        installed.committed = true;
        restoreInstalledPosition(sdkStatus);
      } catch {
        if (installed.isCurrent()) {
          pausePlayback(player);
          onDiscontinuity();
          setStatus('error');
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [player, sourceRevision, onDiscontinuity, restoreInstalledPosition]);
  useEffect(() => {
    const time = player.addListener('timeUpdate', (event) => {
      if (ended.current) return;
      if (!replacing.current && installedSource.current?.restored) resumePosition.current = event.currentTime;
      setPosition(event.currentTime);
      onSample({
        positionMs: event.currentTime * 1000,
        monotonicMs: performance.now(),
        playing: playbackIntent.current && !replacing.current && player.playing && player.playbackRate === 1,
        visible: active && visible.current,
        buffering: player.status !== 'readyToPlay',
      });
    });
    const state = player.addListener('statusChange', (event) => {
      if (ended.current) return;
      setStatus(playbackStatus(event.status, player.playing));
      restoreInstalledPosition(event.status);
      if (event.status !== 'readyToPlay') onDiscontinuity();
    });
    const changed = player.addListener('playingChange', (event) => {
      if (ended.current) return;
      const permitted = playbackIntent.current && !replacing.current && activeRef.current && visible.current;
      if (event.isPlaying && !permitted) pausePlayback(player);
      setPlaying(event.isPlaying && permitted);
      onDiscontinuity();
    });
    const completed = player.addListener('playToEnd', () => {
      if (ended.current) return;
      playbackIntent.current = false;
      pausePlayback(player);
      setPlaying(false);
      onDiscontinuity();
    });
    return () => {
      time.remove();
      state.remove();
      changed.remove();
      completed.remove();
    };
  }, [player, onSample, onDiscontinuity, active, restoreInstalledPosition]);
  const focus = useFocusRing('onDark');
  const seekBy = (delta: number) => {
    if (ended.current) return;
    onDiscontinuity();
    seekPlayback(player, Math.max(0, Math.min(durationMs / 1000, player.currentTime + delta)));
    resumePosition.current = player.currentTime;
    setPosition(player.currentTime);
  };
  const togglePlayback = () => {
    if (ended.current) return;
    if (status === 'error') {
      setAttempt((value) => value + 1);
    } else if (playing) {
      playbackIntent.current = false;
      pausePlayback(player);
    } else if (active) {
      if (player.currentTime >= durationMs / 1000 - 0.05) {
        onDiscontinuity();
        seekPlayback(player, 0);
        resumePosition.current = 0;
      }
      playbackIntent.current = true;
      if (needsRefresh.current) void refreshSource.current();
      else player.play();
    }
  };
  const toggleMuted = () => {
    if (ended.current) return;
    const next = !muteIntent.current;
    try {
      // Keep SDK autoplay inaudible while replacement is pending. Its finally block
      // restores the latest explicit intent only after pausing the player.
      if (!replacing.current) mutePlayback(player, next);
    } catch {
      return; // A released native SharedObject cannot accept a sound change.
    }
    muteIntent.current = next;
    setMuted(next);
    onMutedChange?.(next);
  };
  const controls = useRef({ toggle: togglePlayback, seekBy });
  useLayoutEffect(() => {
    controls.current = { toggle: togglePlayback, seekBy };
  });
  useImperativeHandle(
    controlsRef,
    () => ({ toggle: () => controls.current.toggle(), seekBy: (seconds) => controls.current.seekBy(seconds) }),
    [],
  );
  const stage = (
    <>
      <VideoView
        player={player}
        style={styles.video}
        nativeControls={false}
        contentFit="contain"
        allowsPictureInPicture={false}
        fullscreenOptions={{ enable: false }}
        accessibilityLabel={title}
      />
      {tapToToggle ? (
        <Pressable
          {...focus.props}
          testID="reel-playback-toggle"
          accessibilityRole="button"
          accessibilityLabel={status === 'error' ? 'Retry' : playing ? 'Pause' : 'Play'}
          onPress={togglePlayback}
          style={[styles.touchSurface, focus.style]}
        >
          {status === 'ready' && !playing ? (
            <View style={styles.playDisc} pointerEvents="none">
              <Icon name="play" size={30} color={content.ink} />
            </View>
          ) : null}
        </Pressable>
      ) : null}
      {status === 'loading' || status === 'buffering' ? (
        <View style={styles.centered} pointerEvents="none" accessibilityLiveRegion="polite">
          <Spinner size={44} color={content.paper} />
        </View>
      ) : null}
      {status === 'error' ? (
        <View style={styles.centered} pointerEvents="none">
          <Text variant="uiLabel" color={content.paper}>
            Playback interrupted. Your place is kept.
          </Text>
        </View>
      ) : null}
    </>
  );
  const playback: ReelPlaybackView = {
    positionMs: position * 1000,
    durationMs,
    playing,
    status,
    muted,
    toggleMuted,
  };
  return (
    <View testID="reel-player" style={styles.frame}>
      <View ref={view} testID="reel-video-stage" style={styles.stage}>
        {renderStage ? renderStage(stage) : stage}
      </View>
      <View style={styles.chrome} pointerEvents="box-none">
        <PlaybackSlot playback={playback}>{children}</PlaybackSlot>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  frame: { flex: 1, width: '100%', minHeight: 0, backgroundColor: content.ink },
  stage: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
  video: { flex: 1, width: '100%', minHeight: 0, height: '100%' },
  touchSurface: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer' as const,
  },
  playDisc: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: spacing[1],
    backgroundColor: overlay.onMediaControl,
  },
  centered: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[8],
  },
  chrome: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
