import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EncounterFeedbackKind, FeedItem } from '../api/types.ts';
import type { WhyView } from '../state/readerStore.ts';
import { WhatLedHere } from './WhatLedHere.tsx';
import { RepresentationSwitch } from './RepresentationSwitch.tsx';
import './reel-player.css';

const EXPOSURE_DWELL_MS = 500;

export interface ReelPlayerProps {
  item: Extract<FeedItem, { kind: 'Reel' }>;
  active: boolean;
  onVisible?: (assetId: string) => void;
  onKeep?: () => void;
  onNext?: () => void;
  keepStatus?: 'idle' | 'saving' | 'kept' | 'failed';
  onReturn?: () => void;
  why?: WhyView;
  onOpenWhy?: () => void;
  onCloseWhy?: () => void;
  onRetryWhy?: () => void;
  onCorrect?: (kind: EncounterFeedbackKind) => void;
  branchPanel?: ReactNode;
  onSwitchRepresentation?: (kind: 'Reel' | 'Scroll') => void;
  onBranchNext?: () => void;
  branchNextLabel?: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function aspectRatio(value: string): string {
  const [width, height] = value.split(':').map(Number);
  return width !== undefined && height !== undefined && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? `${width} / ${height}`
    : '9 / 16';
}

export function ReelPlayer({
  item,
  active,
  onVisible,
  onKeep,
  onNext,
  keepStatus = 'idle',
  onReturn,
  why,
  onOpenWhy,
  onCloseWhy,
  onRetryWhy,
  onCorrect,
  branchPanel,
  onSwitchRepresentation,
  onBranchNext,
  branchNextLabel = 'Find connections',
}: ReelPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const visibleAssetRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [loading, setLoading] = useState(active);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(item.durationSeconds);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setFailed(false);
    setAutoplayBlocked(false);
    setPlaying(false);
    setPosition(0);
    setDuration(item.durationSeconds);
  }, [item.assetId, item.durationSeconds]);

  useEffect(() => {
    if (!stage || !active || !onVisible || visibleAssetRef.current === item.assetId) return undefined;
    let ratio = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearDwell = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const attempt = () => {
      clearDwell();
      if (document.visibilityState !== 'visible' || ratio < 0.6 || visibleAssetRef.current === item.assetId) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (document.visibilityState === 'visible' && ratio >= 0.6 && visibleAssetRef.current !== item.assetId) {
          visibleAssetRef.current = item.assetId;
          onVisible(item.assetId);
          // A settled, visible Reel may start muted. Browsers can still reject the request;
          // the play control remains available and explains the required action.
          const video = videoRef.current;
          if (video?.paused && video.muted) {
            void video.play().catch(() => {
              if (!cancelled) setAutoplayBlocked(true);
            });
          }
        }
      }, EXPOSURE_DWELL_MS);
    };
    const observer = new IntersectionObserver((entries) => {
      ratio = entries.at(-1)?.intersectionRatio ?? 0;
      attempt();
    }, { threshold: [0, 0.6, 1] });
    observer.observe(stage);
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') videoRef.current?.pause();
      attempt();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      clearDwell();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [active, item.assetId, onVisible, stage]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!active) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      setLoading(false);
      setPlaying(false);
      setBuffering(false);
      setPosition(0);
      return;
    }
    // StrictMode replays effect cleanup in development. Cleanup removes the source to release
    // Safari's media request; React does not reapply an unchanged `src` prop on the replay.
    // Reattach it explicitly so both the replay and a later reactivation can load the Reel.
    video.setAttribute('src', item.mediaUrl);
    video.load();
    setLoading(true);
    setBuffering(false);
    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [active, item.assetId, item.mediaUrl, retry]);

  function togglePlayback() {
    const video = videoRef.current;
    if (!video || !active || failed) return;
    if (video.ended) video.currentTime = 0;
    if (video.paused) {
      setAutoplayBlocked(false);
      setBuffering(true);
      void video.play().catch(() => {
        setBuffering(false);
        setPlaying(false);
        setAutoplayBlocked(true);
      });
    } else {
      video.pause();
    }
  }

  function seek(value: number) {
    const video = videoRef.current;
    if (!video || !active) return;
    video.currentTime = value;
    setPosition(value);
  }

  const durationValue = Number.isFinite(duration) && duration > 0 ? duration : item.durationSeconds;
  const keepLabel = keepStatus === 'kept' ? 'Kept' : keepStatus === 'saving' ? 'Keeping…' : 'Keep this Reel';
  const openWhy = why?.status === 'open' && why.assetId === item.assetId ? why : null;

  return (
    <main className="reel-player" aria-label="Reel" aria-busy={active && (loading || buffering)}>
      <div className="reel-top">
        {onReturn && <button className="reel-return" type="button" onClick={onReturn}>‹ Universe</button>}
        {onSwitchRepresentation && <RepresentationSwitch selected="Reel" onSelect={onSwitchRepresentation} />}
      </div>
      <header className="reel-heading">
        <p className="reel-eyebrow">Reel <span className="reel-truth">Synthesis</span></p>
        <h1>{item.title}</h1>
        <div className="reel-provenance">
          {item.generatedLabel && <span className="reel-label">Generated Reel</span>}
          {item.simulated && <span className="reel-simulated" role="status">Simulated media</span>}
          {item.check?.by === 'engine' && <span className="reel-engine-checked">Engine-checked</span>}
        </div>
      </header>

      <nav className="reel-wayfinding" aria-label="Reel navigation">
        {onNext && <button type="button" onClick={onNext} aria-label="Next Reel"><span aria-hidden="true">↑</span> Next</button>}
        {onBranchNext && <button type="button" onClick={onBranchNext} aria-label={branchNextLabel}><span aria-hidden="true">←</span> Connection</button>}
      </nav>

      <div className="reel-stage" style={{ aspectRatio: aspectRatio(item.aspect) }} ref={setStage}>
        <video
          key={`${item.assetId}:${retry}`}
          ref={videoRef}
          className="reel-video"
          src={active ? item.mediaUrl : undefined}
          playsInline
          preload={active ? 'metadata' : 'none'}
          muted={muted}
          aria-label={`Video: ${item.title}`}
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          onLoadedData={() => setLoading(false)}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onPlay={() => {
            if (!active) {
              videoRef.current?.pause();
              return;
            }
            setPlaying(true);
            setBuffering(false);
          }}
          onPause={() => setPlaying(false)}
          onWaiting={() => setBuffering(true)}
          onCanPlay={() => { setLoading(false); setBuffering(false); }}
          onEnded={() => { setPlaying(false); setPosition(durationValue); }}
          onError={() => { setFailed(true); setBuffering(false); setPlaying(false); }}
        />
        {!active && <p className="reel-media-state" role="status">Playback paused</p>}
        {active && loading && !failed && <p className="reel-media-state" role="status">Loading video…</p>}
        {active && buffering && !loading && !failed && <p className="reel-media-state" role="status">Buffering video…</p>}
        {active && failed && (
          <div className="reel-error" role="alert">
            <p>Video could not be loaded.</p>
            <button type="button" onClick={() => { setFailed(false); setRetry((value) => value + 1); }}>Retry video</button>
          </div>
        )}
        {active && autoplayBlocked && !failed && <p className="reel-media-state" role="status">Tap Play to start this Reel.</p>}
        {active && !failed && (
          <div className="reel-controls" aria-label="Video controls">
            <button type="button" onClick={togglePlayback} aria-label={playing ? 'Pause video' : position >= durationValue ? 'Replay video' : 'Play video'}>
              {playing ? 'Pause' : position >= durationValue ? 'Replay' : 'Play'}
            </button>
            <label className="reel-seek-label">
              <span className="sr-only">Video progress</span>
              <input
                type="range"
                min="0"
                max={durationValue}
                step="0.1"
                value={Math.min(position, durationValue)}
                onChange={(event) => seek(Number(event.currentTarget.value))}
                aria-valuetext={`${formatTime(position)} of ${formatTime(durationValue)}`}
              />
            </label>
            <span className="reel-time" aria-label="Video time">{formatTime(position)} / {formatTime(durationValue)}</span>
            <button type="button" onClick={() => setMuted((value) => !value)} aria-label={muted ? 'Unmute video' : 'Mute video'}>
              {muted ? 'Unmute' : 'Mute'}
            </button>
          </div>
        )}
      </div>

      <p className="reel-summary">{item.summary}</p>
      {keepStatus === 'failed' && <p className="reel-action-status" role="alert">Could not keep this Reel. Please try again.</p>}
      <nav className="reel-actions" aria-label="Reel actions">
        {onKeep && <button type="button" onClick={onKeep} disabled={keepStatus === 'saving' || keepStatus === 'kept'}>{keepLabel}</button>}
        {onNext && <button type="button" onClick={onNext}>Next discovery</button>}
        {onOpenWhy && <button type="button" onClick={openWhy ? onCloseWhy : onOpenWhy} aria-expanded={openWhy !== null}>Why this appeared</button>}
      </nav>
      {branchPanel}
      {openWhy && <aside className="reel-why" aria-label="Why this Reel appeared">
        <p>{item.reason.trim() || 'No explanation recorded.'}</p>
        <p>Truth state: synthesis. This Reel is generated media.</p>
        {item.check?.by === 'engine' && <section className="reel-how-checked" aria-label="How it was checked">
          <h2>How it was checked</h2>
          <ul>
            <li>Every sentence it says is tied to the sources of the Scroll it was made from.</li>
            <li>The video engine looked at each shot it shows and checked it against what that shot had to show and must never show.</li>
            <li>KnowScroll checked the video file, its labels, and that it doesn't repeat another Reel.</li>
          </ul>
          <p>The shot check was done by the engine that made the Reel, not by an independent reviewer. That's what “Engine-checked” means.</p>
        </section>}
        {onCorrect && onRetryWhy && <WhatLedHere view={openWhy} onCorrect={onCorrect} onRetry={onRetryWhy} />}
      </aside>}
    </main>
  );
}
