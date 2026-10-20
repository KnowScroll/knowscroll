import { useEffect, useRef, useState, type ComponentRef } from 'react';
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

export interface ReelPlayerProps {
  readonly title: string;
  readonly durationMs: number;
  readonly active: boolean;
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
  const resumePosition = useRef(0);
  const playbackIntent = useRef(false);
  const replacing = useRef(false);
  const needsRefresh = useRef(true);
  const loaded = useRef(false);
  const refreshSource = useRef<() => Promise<void>>(() => Promise.resolve());
  const [status, setStatus] = useState<'loading' | 'ready' | 'buffering' | 'error'>('loading');
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [sourceRevision, setSourceRevision] = useState(0);
  const installedPosition = useRef(0);

  useEffect(
    () =>
      observeMediaVisibility(view.current, (value) => {
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
        resumePosition.current = player.currentTime;
        pausePlayback(player);
        void player.replaceAsync(null).catch(() => undefined);
      } catch {
        /* Already released by expo-video. */
      }
    };
    const unregister = registerEnd(stop);
    const refresh = async (allowPaused = false) => {
      if (disposed || refreshing) return;
      // Buffered media can remain paused past grant expiry. Obtain a fresh grant only on
      // explicit Play; SDK58 source replacement itself tries autoplay on web.
      if (loaded.current && !allowPaused && (!playbackIntent.current || !activeRef.current || !visible.current)) {
        needsRefresh.current = true;
        return;
      }
      refreshing = true;
      try {
        const grant = await loadSource();
        if (disposed) return;
        if (loaded.current && !allowPaused && (!playbackIntent.current || !activeRef.current || !visible.current)) {
          needsRefresh.current = true;
          return;
        }
        const time = Math.max(player.currentTime, resumePosition.current);
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
          pausePlayback(player);
        } finally {
          player.muted = wasMuted;
        }
        if (disposed) {
          pausePlayback(player);
          return;
        }
        // SDK58's web replaceAsync starts the HTML video itself. Fence that internal autoplay:
        // every replacement is paused first, and only current explicit intent can resume it.
        pausePlayback(player);
        setPlaying(false);
        installedPosition.current = time;
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
        if (!disposed) {
          pausePlayback(player);
          onDiscontinuity();
          setStatus('error');
        }
      } finally {
        refreshing = false;
        replacing.current = false;
      }
    };
    refreshSource.current = () => refresh();
    void refresh(true);
    return () => {
      unregister();
      stop();
    };
  }, [player, loadSource, registerEnd, onDiscontinuity, attempt]);
  useEffect(() => {
    if (sourceRevision === 0) return;
    seekPlayback(player, installedPosition.current);
    resumePosition.current = installedPosition.current;
    setPosition(installedPosition.current);
    if (playbackIntent.current && activeRef.current && visible.current) player.play();
  }, [player, sourceRevision]);
  useEffect(() => {
    const time = player.addListener('timeUpdate', (event) => {
      resumePosition.current = event.currentTime;
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
      setStatus(
        event.status === 'error'
          ? 'error'
          : event.status === 'readyToPlay'
            ? 'ready'
            : player.playing
              ? 'buffering'
              : 'loading',
      );
      if (event.status !== 'readyToPlay') onDiscontinuity();
    });
    const changed = player.addListener('playingChange', (event) => {
      const permitted = playbackIntent.current && !replacing.current && activeRef.current && visible.current;
      if (event.isPlaying && !permitted) pausePlayback(player);
      setPlaying(event.isPlaying && permitted);
      onDiscontinuity();
    });
    const ended = player.addListener('playToEnd', () => {
      playbackIntent.current = false;
      pausePlayback(player);
      setPlaying(false);
      onDiscontinuity();
    });
    return () => {
      time.remove();
      state.remove();
      changed.remove();
      ended.remove();
    };
  }, [player, onSample, onDiscontinuity, active]);
  const seek = (delta: number) => {
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
