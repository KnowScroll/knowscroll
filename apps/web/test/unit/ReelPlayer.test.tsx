import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem } from '../../src/api/types.ts';
import { ReelPlayer } from '../../src/components/ReelPlayer.tsx';

const item: Extract<FeedItem, { kind: 'Reel' }> = {
  assetId: 'd9428888-122b-4c70-97c2-10ac9527a602',
  revision: 1,
  kind: 'Reel',
  title: 'A small Reel',
  summary: 'A sourced summary.',
  truthState: 'synthesis',
  generatedLabel: true,
  simulated: true,
  mediaUrl: '/v1/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  durationSeconds: 12,
  aspect: '1080:1920',
  reason: 'A labelled test encounter.',
};

describe('ReelPlayer', () => {
  let originalLoad: PropertyDescriptor | undefined;
  let originalPause: PropertyDescriptor | undefined;
  let originalPlay: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalLoad = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'load');
    originalPause = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'pause');
    originalPlay = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play');
    Object.defineProperty(HTMLMediaElement.prototype, 'load', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: vi.fn(() => Promise.resolve()) });
  });

  afterEach(() => {
    cleanup();
    for (const [name, descriptor] of [['load', originalLoad], ['pause', originalPause], ['play', originalPlay]] as const) {
      if (descriptor) Object.defineProperty(HTMLMediaElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLMediaElement.prototype, name);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows truthful provenance and playback controls without exposing source identifiers', () => {
    const onKeep = vi.fn();
    render(<ReelPlayer item={item} active onKeep={onKeep} keepStatus="saving" />);

    expect(screen.getByRole('heading', { name: item.title })).toBeInTheDocument();
    expect(screen.getByText('Simulated media')).toBeInTheDocument();
    expect(screen.queryByText('Source Scroll')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Source Scroll' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keeping…' })).toBeDisabled();
    const video = screen.getByLabelText(`Video: ${item.title}`) as HTMLVideoElement;
    expect(video).toHaveAttribute('playsinline');
    expect(video).toHaveAttribute('src', item.mediaUrl);
  });

  it('reports visibility only while active and pauses and unloads when deactivated', () => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', class {
      private callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
      observe(target: Element) {
        this.callback([{ intersectionRatio: 0.8, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });
    const onVisible = vi.fn();
    const { rerender } = render(<ReelPlayer item={item} active={false} onVisible={onVisible} />);
    const video = screen.getByLabelText(`Video: ${item.title}`) as HTMLVideoElement;
    expect(onVisible).not.toHaveBeenCalled();

    rerender(<ReelPlayer item={item} active onVisible={onVisible} />);
    expect(onVisible).not.toHaveBeenCalled();
    rerender(<ReelPlayer item={item} active={false} onVisible={onVisible} />);
    act(() => vi.advanceTimersByTime(500));
    expect(onVisible).not.toHaveBeenCalled();
    rerender(<ReelPlayer item={item} active onVisible={onVisible} />);
    act(() => vi.advanceTimersByTime(500));
    expect(onVisible).toHaveBeenCalledWith(item.assetId);
    rerender(<ReelPlayer item={item} active={false} onVisible={onVisible} />);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    expect(video).not.toHaveAttribute('src');
    expect(screen.getByText('Playback paused')).toBeInTheDocument();
  });

  it('tries muted playback after visible dwell and preserves a manual play action when blocked', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', class {
      private callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
      observe(target: Element) {
        this.callback([{ intersectionRatio: 0.8, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });
    const blockedPlay = vi.fn(() => Promise.reject(new Error('autoplay blocked')));
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: blockedPlay });
    const onVisible = vi.fn();
    render(<ReelPlayer item={item} active onVisible={onVisible} />);
    await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve(); });
    expect(onVisible).toHaveBeenCalledWith(item.assetId);
    expect(blockedPlay).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Tap Play to start this Reel.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play video' })).toBeInTheDocument();
  });

  it('supports play, mute, seeking, duration updates, and replay after ending', () => {
    render(<ReelPlayer item={item} active />);
    const video = screen.getByLabelText(`Video: ${item.title}`) as HTMLVideoElement;
    fireEvent.click(screen.getByRole('button', { name: 'Play video' }));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    fireEvent.play(video);
    expect(screen.getByRole('button', { name: 'Pause video' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Unmute video' }));
    expect(screen.getByRole('button', { name: 'Mute video' })).toBeInTheDocument();
    Object.defineProperty(video, 'duration', { configurable: true, value: 18 });
    fireEvent.loadedMetadata(video);
    const seek = screen.getByRole('slider', { name: 'Video progress' });
    fireEvent.change(seek, { target: { value: '4' } });
    expect(video.currentTime).toBe(4);
    fireEvent.ended(video);
    expect(screen.getByRole('button', { name: 'Replay video' })).toBeInTheDocument();
  });

  it('announces media errors and retries by reloading the same protected URL', () => {
    render(<ReelPlayer item={item} active />);
    fireEvent.error(screen.getByLabelText(`Video: ${item.title}`));
    expect(screen.getByRole('alert')).toHaveTextContent('Video could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry video' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText(`Video: ${item.title}`)).toHaveAttribute('src', item.mediaUrl);
  });
});
