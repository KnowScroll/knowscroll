import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App.tsx';
import type { ApiClient } from '../../src/api/client.ts';
import { ApiException } from '../../src/api/client.ts';
import { hasSeenOrigin, markOriginSeen } from '../../src/cosmos/originStorage.ts';
import { createBrowserStorage } from '../../src/state/storage.ts';
import { FakeApi, universeOf } from './fakeApi.ts';
import { atlasOf, ids, planet } from './skyFixture.ts';

/** ADR-0049 §5: who sees the opening, and that the Universe beneath it is sealed until the handoff. */
function renderApp(api: FakeApi) {
  return render(<App apiClient={api as unknown as ApiClient} onSignedOut={vi.fn()} />);
}

const shell = () => document.querySelector('.app-shell') as HTMLElement;
const trace = { eventId: 'trace-1', assetId: 'asset-1', title: 'A rhythm the ocean keeps', createdAt: '2026-09-30T10:00:00Z' };

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has no WebGL; the opening takes its CSS path.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('App: the cosmic-origin opening', () => {
  it('plays for a first visit over a sealed Universe; Skip unseals it and is remembered', async () => {
    const api = new FakeApi();
    api.universeQueue.push(universeOf({ traces: [] }));
    api.atlasQueue.push(atlasOf([]));
    renderApp(api);
    expect(screen.getByTestId('origin')).toBeInTheDocument();
    expect(shell()).toHaveAttribute('inert');
    await waitFor(() => expect(screen.getByRole('button', { name: /A first possibility/, hidden: true })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.queryByTestId('origin')).not.toBeInTheDocument();
    expect(shell()).not.toHaveAttribute('inert');
    expect(hasSeenOrigin()).toBe(true);
    expect(screen.getByRole('button', { name: /A first possibility/ })).toBeInTheDocument();
  });

  it('can be replayed from the Universe, sealing it again until skipped', async () => {
    markOriginSeen();
    const api = new FakeApi();
    api.universeQueue.push(universeOf({ traces: [] }));
    api.atlasQueue.push(atlasOf([]));
    renderApp(api);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replay the opening' })).toBeInTheDocument());
    expect(screen.queryByTestId('origin')).not.toBeInTheDocument();
    expect(shell()).not.toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: 'Replay the opening' }));
    expect(screen.getByTestId('origin')).toBeInTheDocument();
    expect(shell()).toHaveAttribute('inert');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('origin')).not.toBeInTheDocument();
    expect(shell()).not.toHaveAttribute('inert');
  });

  it('a reader this browser already knows goes straight to the Universe', async () => {
    createBrowserStorage().observePrivacyState(universeOf().universeId, 0);
    const api = new FakeApi();
    api.universeQueue.push(universeOf({ traces: [] }));
    api.atlasQueue.push(atlasOf([]));
    renderApp(api);
    expect(screen.queryByTestId('origin')).not.toBeInTheDocument();
    expect(shell()).not.toHaveAttribute('inert');
    await waitFor(() => expect(screen.getByRole('button', { name: /A first possibility/ })).toBeInTheDocument());
  });

  it.each([
    ['kept Traces', { traces: [trace] }, atlasOf([])],
    ['stars', { traces: [] }, atlasOf([planet(ids.gravity, 'Gravity')])],
  ])('a first visit whose universe already has %s gives way at once and is remembered', async (_, universe, atlas) => {
    const api = new FakeApi();
    api.universeQueue.push(universeOf(universe));
    api.atlasQueue.push(atlas);
    renderApp(api);
    expect(screen.getByTestId('origin')).toBeInTheDocument();
    // Held: a dark frame with no story and no controls until the history is known, and never any
    // controls afterwards either (watched on every DOM change, not just at the end).
    let controlsSeen = false;
    const watch = new MutationObserver(() => { if (document.querySelector('.origin-controls')) controlsSeen = true; });
    watch.observe(document.body, { childList: true, subtree: true });
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('origin')).not.toBeInTheDocument());
    watch.disconnect();
    expect(controlsSeen).toBe(false);
    expect(shell()).not.toHaveAttribute('inert');
    expect(hasSeenOrigin()).toBe(true);
  });

  it('a first visit starts the story only once the Universe is known to be new', async () => {
    const api = new FakeApi();
    api.universeQueue.push(universeOf({ traces: [] }));
    api.atlasQueue.push(atlasOf([]));
    renderApp(api);
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument());
    expect(screen.getByTestId('origin')).not.toHaveAttribute('aria-busy');
  });

  it('an unavailable Universe ends the opening without remembering it, so it can play next time', async () => {
    const api = new FakeApi();
    api.universeQueue.push(new ApiException({ kind: 'network', message: 'connection reset' }));
    renderApp(api);
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('origin')).not.toBeInTheDocument());
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'The universe is unavailable' })).toBeInTheDocument();
    expect(shell()).not.toHaveAttribute('inert');
    expect(hasSeenOrigin()).toBe(false);
  });
});
