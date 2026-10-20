import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentRef, type Ref } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { VideoView, useVideoPlayer, type VideoSource, type VideoPlayer } from 'expo-video';
import { spacing, content } from '@knowscroll/design-tokens';
import { Text } from '../text/text';
import { Button } from '../actions/button';
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
}
export interface ReelPositionHandle {
  /** Synchronous SDK snapshot; null while unavailable, replacing, or released. */
  capture(): ReelLocalPosition | null;
  /** Park immediately without emitting a sample or granting future playback intent. */
  pause(): void;
}
type PlaybackStatus = 'loading' | 'ready' | 'buffering' | 'error';
function playbackStatus(status: VideoPlayer['status'], playing: boolean): PlaybackStatus {
  return status === 'error' ? 'error' : status === 'readyToPlay' ? 'ready' : playing ? 'buffering' : 'loading';
}

export interface ReelPlayerProps {
  readonly title: string;
  readonly durationMs: number;
  readonly active: boolean;
  /** Mount-only restore intent in milliseconds. Non-finite values become zero. */
  readonly initialPositionMs?: number;
  readonly positionRef?: Ref<ReelPositionHandle>;
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
/** The same expo-video player on native and web; web cookies and native headers are supplied by
 * AccountScope. A grant renews before expiry without opening/activating another exposure. */
export function ReelPlayer({
  title,
  durationMs,
  active,
  initialPositionMs,
  positionRef,
  loadSource,
  onSample,
  onDiscontinuity,
  registerEnd,
}: ReelPlayerProps) {
  const window = useWindowDimensions();
  const player = useVideoPlayer(null, (instance) => {
    instance.loop = false;
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
  const playbackIntent = useRef(false);
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
          return { positionMs: clampPositionMs(seconds * 1000, durationMs), playing: player.playing };
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
        const wasMuted = player.muted;
        player.muted = true;
        try {
          const pending = player.replaceAsync(grant.source);
          // Web replaceAsync calls HTMLVideoElement.play synchronously. Cancel it in this
          // same JS turn, before its asynchronous playback task, with audio already muted.
          pausePlayback(player);
          await pending;
          if (!disposed && !ended.current) pausePlayback(player);
        } finally {
          if (!disposed && !ended.current) player.muted = wasMuted;
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
  const seek = (delta: number) => {
    if (ended.current) return;
    onDiscontinuity();
    seekPlayback(player, Math.max(0, Math.min(durationMs / 1000, player.currentTime + delta)));
    resumePosition.current = player.currentTime;
    setPosition(player.currentTime);
  };
  return (
    <View ref={view} style={[styles.frame, { height: Math.max(300, window.height - 300) }]}>
      <VideoView
        player={player}
        style={styles.video}
        nativeControls={false}
        contentFit="contain"
        allowsPictureInPicture={false}
        fullscreenOptions={{ enable: false }}
        accessibilityLabel={title}
      />
      {status !== 'ready' ? (
        <View style={styles.poster} pointerEvents="none">
          <Text color={content.paper} variant="uiLabel">
            {status === 'error' ? 'Playback interrupted' : status === 'buffering' ? 'Buffering…' : title}
          </Text>
        </View>
      ) : null}
      <View style={styles.controls}>
        <Text variant="uiS" color={content.paper}>
          {Math.floor(position)} / {Math.round(durationMs / 1000)} s · Captions in video
        </Text>
        <View style={styles.buttons}>
          <Button label="Back 10s" size="sm" variant="default" onPress={() => seek(-10)} />
          <Button
            size="sm"
            label={status === 'error' ? 'Retry' : playing ? 'Pause' : 'Play'}
            onPress={() => {
              if (ended.current) return;
              if (status === 'error') setAttempt((value) => value + 1);
              else if (playing) {
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
            }}
          />
          <Button label="Forward 10s" size="sm" variant="default" onPress={() => seek(10)} />
        </View>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  frame: { width: '100%', maxWidth: 480, alignSelf: 'center', backgroundColor: '#151515' },
  video: { flex: 1, width: '100%', minHeight: 0, height: '100%' },
  poster: { position: 'absolute', top: '40%', left: spacing[5], right: spacing[5], alignItems: 'center' },
  controls: { padding: spacing[3], gap: spacing[2], backgroundColor: '#151515' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing[2] },
});
