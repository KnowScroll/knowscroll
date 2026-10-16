import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UniverseScreen } from '../../src/components/UniverseScreen.tsx';
import { universeOf } from './fakeApi.ts';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';
import { deriveSky } from '../../src/cosmos/starView.ts';
import { atlasOf, ids, planet, twoStarSky } from './skyFixture.ts';

const storage = new ReaderStorage(new MemoryStorageBackend());

function loaded(traceCount: number) {
  const traces = Array.from({ length: traceCount }, (_, i) => ({
    eventId: `event-${i}`,
    assetId: `asset-${i}`,
    title: `Kept Scroll ${i}`,
    createdAt: '2026-09-20T10:00:00.000Z',
  }));
  return { status: 'loaded' as const, universe: universeOf({ traces }) };
}

describe('UniverseScreen', () => {
  it('offers a real way into the Atlas once the universe has bodies to group', () => {
    const onEnterSystem = vi.fn();
    render(
      <UniverseScreen
        state={loaded(3)}
        storage={storage}
        onEnterScroll={vi.fn()}
        onOpenTrace={vi.fn()}
        onEnterSystem={onEnterSystem}
        onOpenPrivacy={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    // A control, not a decorative label. The label read "SYSTEM VIEW" on one surface while
    // doing nothing at all, which claimed a depth that surface could not reach; the level is
    // real now (#116), so the label has to actually go there.
    const control = screen.getByRole('button', { name: 'Atlas — open your places' });
    expect(control).toBeInTheDocument();
    fireEvent.click(control);
    expect(onEnterSystem).toHaveBeenCalledTimes(1);
  });

  it('offers Atlas inspection even when no Traces have been kept', () => {
    render(
      <UniverseScreen
        state={loaded(0)}
        storage={storage}
        onEnterScroll={vi.fn()}
        onOpenTrace={vi.fn()}
        onEnterSystem={vi.fn()}
        onOpenPrivacy={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    // No Keep does not imply no encounters. The API, not this collection count, owns the empty system.
    expect(screen.getByRole('button', { name: 'Atlas — open your places' })).toBeInTheDocument();
  });

  it('offers a real way into the privacy panel regardless of whether anything has been kept (#119)', () => {
    const onOpenPrivacy = vi.fn();
    const { rerender } = render(
      <UniverseScreen
        state={loaded(0)}
        storage={storage}
        onEnterScroll={vi.fn()}
        onOpenTrace={vi.fn()}
        onEnterSystem={vi.fn()}
        onOpenPrivacy={onOpenPrivacy}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open privacy controls' }));
    expect(onOpenPrivacy).toHaveBeenCalledTimes(1);

    rerender(
      <UniverseScreen
        state={loaded(3)}
        storage={storage}
        onEnterScroll={vi.fn()}
        onOpenTrace={vi.fn()}
        onEnterSystem={vi.fn()}
        onOpenPrivacy={onOpenPrivacy}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open privacy controls' })).toBeInTheDocument();
  });
});

describe('UniverseScreen: the sky of stars (ADR-0051)', () => {
  const skyOf = (response = twoStarSky()) => ({ status: 'loaded' as const, response, settingAside: null, error: null });

  function renderSky(overrides: Partial<Parameters<typeof UniverseScreen>[0]> = {}) {
    const props = {
      state: loaded(0),
      storage,
      sky: skyOf(),
      reducedMotion: true,
      onEnterScroll: vi.fn(),
      onOpenTrace: vi.fn(),
      onEnterSystem: vi.fn(),
      onOpenPrivacy: vi.fn(),
      onRetry: vi.fn(),
      onRetrySky: vi.fn(),
      onReadFrom: vi.fn<(placeId: string, name: string) => void>(),
      onSetAside: vi.fn<(placeId: string) => void>(),
      ...overrides,
    };
    const view = render(<UniverseScreen {...props} />);
    return { ...view, props };
  }

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('draws each star as a button whose name carries its condition and what it holds, and no seed', () => {
    renderSky();
    const nav = screen.getByRole('navigation', { name: 'Your stars' });
    const stars = within(nav).getAllByRole('button');
    expect(stars.map(button => button.getAttribute('aria-label'))).toEqual([
      'Gravity: under tension. 2 worlds · 2 questions · 2 possibilities. Approach this star.',
      expect.stringMatching(/^Light: taking shape\./),
    ]);
    expect(screen.getByRole('heading', { level: 1, name: 'Your sky, so far.' })).toBeInTheDocument();
    expect(screen.getByText('Gravity and Light. One connection runs between them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /A first possibility/ })).not.toBeInTheDocument();
    expect(document.querySelector('[data-origin-target]')).toBeNull();
  });

  it('a quiet star says so in its name, and a lone star is named in the heading', () => {
    renderSky({ sky: skyOf(atlasOf([planet(ids.music, 'Music', { attention: { state: 'dormant', episodes: 9, daysActive: 5 } })])) });
    expect(screen.getByRole('button', { name: 'Music: quiet. Quiet. Approach this star.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'A first star: Music.' })).toBeInTheDocument();
  });

  it('a star opens its system with "Why it looks like this", and reading from it scopes to the star', () => {
    const { props } = renderSky();
    fireEvent.click(screen.getByRole('button', { name: /^Gravity: / }));
    const system = screen.getByRole('region', { name: 'Gravity, a star in your universe' });
    expect(within(system).getByRole('heading', { level: 2, name: 'Gravity' })).toHaveFocus();
    const why = within(system).getByRole('heading', { name: 'Why it looks like this' }).closest('section')!;
    expect(within(why as HTMLElement).getAllByRole('listitem').map(item => item.textContent)).toEqual(deriveSky(twoStarSky()).stars[0]!.reasons.map(reason => reason.text));
    expect(within(system).getByText('Under tension')).toBeInTheDocument();
    expect(within(system).getByRole('heading', { name: 'At its edge, not met yet' })).toBeInTheDocument();

    fireEvent.click(within(system).getAllByRole('button', { name: 'Read from Gravity' })[0]!);
    expect(props.onReadFrom).toHaveBeenCalledWith(ids.gravity, 'Gravity');
    expect(props.onEnterScroll).not.toHaveBeenCalled();

    fireEvent.click(within(system).getByRole('button', { name: '‹ Universe' }));
    expect(screen.getByRole('navigation', { name: 'Your stars' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Gravity: / }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: /a star in your universe/ })).not.toBeInTheDocument();
  });

  it('landing on a facet world reads from that world; landing on a question world reads from the place its room is on', () => {
    const { props } = renderSky();
    fireEvent.click(screen.getByRole('button', { name: /^Gravity: / }));
    fireEvent.click(screen.getByRole('button', { name: 'Land on Orbits, a world inside Gravity' }));
    const landing = screen.getByRole('region', { name: 'Planet landing' });
    expect(within(landing).getByRole('heading', { level: 1, name: 'Orbits' })).toBeInTheDocument();
    expect(within(landing).getByText('A world inside Gravity')).toBeInTheDocument();
    expect(within(landing).getByText('A narrower part of Gravity. It formed from what you kept, asked or followed there.')).toBeInTheDocument();
    fireEvent.click(within(landing).getByRole('button', { name: 'Read from Orbits' }));
    expect(props.onReadFrom).toHaveBeenLastCalledWith(ids.orbits, 'Orbits');

    // (The app leaves for the Scroll here; this screen alone stays at the star.)
    fireEvent.click(screen.getByRole('button', { name: 'Land on the question world: Why are orbits ellipses?' }));
    const question = screen.getByRole('region', { name: 'Planet landing' });
    expect(within(question).getByText('A question world in Orbits')).toBeInTheDocument();
    expect(within(question).getByText('Your reading')).toBeInTheDocument();
    // Back returns to the star, not to the sky.
    fireEvent.click(within(question).getByRole('button', { name: '‹ Gravity' }));
    expect(screen.getByRole('region', { name: 'Gravity, a star in your universe' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Land on the question world: Why are orbits ellipses?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read from Orbits' }));
    expect(props.onReadFrom).toHaveBeenLastCalledWith(ids.orbits, 'Orbits');
    expect(props.onReadFrom).toHaveBeenCalledTimes(2);
  });

  it('follows a constellation line to the other star', () => {
    renderSky();
    fireEvent.click(screen.getByRole('button', { name: /^Gravity: / }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to Light' }));
    expect(screen.getByRole('region', { name: 'Light, a star in your universe' })).toBeInTheDocument();
  });

  it('asks before setting a star aside, and closes its system once the star is gone', () => {
    const { props, rerender } = renderSky();
    fireEvent.click(screen.getByRole('button', { name: /^Gravity: / }));
    fireEvent.click(screen.getByRole('button', { name: 'Set this star aside' }));
    const confirm = screen.getByRole('group', { name: 'Set Gravity aside?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    expect(props.onSetAside).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Set this star aside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set it aside' }));
    expect(props.onSetAside).toHaveBeenCalledWith(ids.gravity);

    rerender(<UniverseScreen {...props} sky={skyOf(atlasOf([planet(ids.light, 'Light')]))} />);
    expect(screen.queryByRole('region', { name: /Gravity, a star/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Light: / })).toBeInTheDocument();
  });

  it('before any star forms, the seed is the first possibility and the opening lands on it', () => {
    for (const sky of [skyOf(atlasOf([])), { status: 'loading' as const }, { status: 'idle' as const }]) {
      const { props, unmount } = renderSky({ sky });
      const seed = screen.getByRole('button', { name: 'A first possibility: see what catches your curiosity' });
      expect(seed).toHaveAttribute('data-origin-target');
      expect(screen.queryByRole('navigation', { name: 'Your stars' })).not.toBeInTheDocument();
      fireEvent.click(seed);
      expect(props.onEnterScroll).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('keeps kept lights as Traces beside the stars', () => {
    const onOpenTrace = vi.fn();
    renderSky({ state: loaded(2), onOpenTrace });
    const kept = screen.getByRole('navigation', { name: 'Saved Traces' });
    fireEvent.click(within(kept).getByRole('button', { name: 'Revisit the saved Trace: Kept Scroll 1' }));
    expect(onOpenTrace).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'event-1' }));
    expect(screen.getByRole('navigation', { name: 'Your stars' })).toBeInTheDocument();
  });

  it('stays usable when the stars cannot be loaded, and offers a retry', () => {
    const { props } = renderSky({ sky: { status: 'unavailable', message: 'Connection interrupted.' } });
    expect(screen.getByText(/Your stars could not be loaded/)).toBeInTheDocument();
    // A reader whose stars failed to load is not told this is a brand-new universe.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Your universe.');
    expect(screen.queryByText('Somewhere new starts here.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(props.onRetrySky).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Enter Scroll' }));
    expect(props.onEnterScroll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /A first possibility/ })).toBeInTheDocument();
  });

  it('draws nothing on a browser\'s first sight of a sky, then announces a later change once, in its recorded words', () => {
    const memory = new ReaderStorage(new MemoryStorageBackend());
    const full = twoStarSky();
    const earlier = { ...full, places: full.places.map(place => (place.placeId === ids.orbits ? { ...place, rooms: [] } : place)) };
    const loadedSky = (response: typeof full) => ({ status: 'loaded' as const, response, settingAside: null, error: null });
    // First sight: this browser cannot know what is recent, so nothing is called "just changed".
    const first = renderSky({ storage: memory, sky: loadedSky(earlier) });
    expect(screen.queryByText(/Just changed/)).not.toBeInTheDocument();
    first.unmount();
    // A question world forms later: the one change this browser has not drawn is announced once.
    const line = 'A question world formed around “Why are orbits ellipses?”.';
    const second = renderSky({ storage: memory, sky: loadedSky(full) });
    expect(screen.getByRole('status')).toHaveTextContent(`Just changed ${line}`);
    second.unmount();
    // Already drawn: the line stays as a quiet caption, no longer announced as new.
    renderSky({ storage: memory, sky: loadedSky(full) });
    expect(screen.queryByText(/Just changed/)).not.toBeInTheDocument();
    expect(screen.getByText(line)).toBeInTheDocument();
  });
});
