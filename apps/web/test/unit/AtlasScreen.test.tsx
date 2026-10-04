import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AtlasScreen, type AtlasScreenProps } from '../../src/components/AtlasScreen.tsx';
import type { WebAtlasResponse as AtlasResponse } from '@knowscroll/contracts/atlas';

const planetId = '00000000-0000-4000-8000-000000000001';
const regionId = '00000000-0000-4000-8000-000000000002';
const sightingId = '00000000-0000-4000-8000-000000000003';
const roomId = '00000000-0000-4000-8000-000000000004';
const deltaId = '00000000-0000-4000-8000-000000000005';

function atlasResponse(overrides: Partial<AtlasResponse> = {}): AtlasResponse {
  return {
    policyVersion: 'cartographer-v1',
    places: [
      {
        placeId: planetId,
        kind: 'planet',
        parentPlaceId: null,
        anchor: { code: 'gravity', name: 'Gravity', description: 'How mass changes motion.' },
        basis: null,
        attention: { state: 'anchored', episodes: 4, daysActive: 2 },
        scrolls: { total: 8, seen: 3 },
        formedAt: '2026-09-20T12:00:00.000Z',
        formedBy: 'cartographer-v1',
        foundation: null,
        rooms: [
          {
            roomId,
            question: 'Does gravity shape the paths we see?',
            state: 'arguing',
            openedAt: '2026-09-21T12:00:00.000Z',
            inhabitants: [
              {
                role: 'reader_of_record',
                claims: [{ key: 'claim-a', statement: 'Mass changes how objects move.', truthState: 'documented', supportKind: 'supports' }],
              },
              {
                role: 'doubter',
                claims: [{ key: 'claim-b', statement: 'The effect depends on the scale.', truthState: 'interpretation', supportKind: 'qualifies' }],
              },
            ],
          },
        ],
        demand: { demandId: '00000000-0000-4000-8000-000000000006', status: 'waiting', reason: null, scroll: null, withdrawn: false },
      },
      {
        placeId: regionId,
        kind: 'region',
        parentPlaceId: planetId,
        anchor: { code: 'orbits', name: 'Orbits', description: 'Paths followed by objects in space.' },
        basis: null,
        attention: { state: 'seen', episodes: 2, daysActive: 1 },
        scrolls: { total: 4, seen: 2 },
        formedAt: '2026-09-21T12:00:00.000Z',
        formedBy: 'cartographer-v1',
        foundation: null,
        rooms: [],
        demand: { demandId: '00000000-0000-4000-8000-000000000007', status: 'cannot_meet', reason: 'no_material', scroll: null, withdrawn: true },
      },
      {
        placeId: sightingId,
        kind: 'sighting',
        parentPlaceId: planetId,
        anchor: { code: 'star-formation', name: 'Star formation', description: 'How stars begin.' },
        basis: {
          kind: 'explains',
          from: 'Gravity',
          to: 'Star formation',
          claim: { text: 'A claim that contains no source label.' },
          bridge: null,
        },
        attention: null,
        scrolls: { total: 0, seen: 0 },
        formedAt: '2026-09-22T12:00:00.000Z',
        formedBy: 'cartographer-v1',
        foundation: null,
        rooms: [],
        demand: null,
      },
    ],
    relations: [
      {
        fromPlaceId: planetId,
        toPlaceId: regionId,
        kind: 'explains',
        claim: { text: 'A connection supported by a claim.' },
        bridge: null,
      },
    ],
    chronicle: [
      {
        deltaId,
        placeId: planetId,
        parentPlaceId: null,
        kind: 'place_formed',
        causalClass: 'personal_exploration',
        at: '2026-09-20T12:00:00.000Z',
        line: 'Gravity became a place through your reading.',
      },
    ],
    ...overrides,
  };
}

function renderAtlas(state: AtlasScreenProps['state'], overrides: Partial<AtlasScreenProps> = {}) {
  const props: AtlasScreenProps = {
    state,
    onReturn: vi.fn(),
    onRetry: vi.fn(),
    onSetAside: vi.fn(),
    ...overrides,
  };
  render(<AtlasScreen {...props} />);
  return props;
}

describe('AtlasScreen', () => {
  it('renders loading and unavailable recovery with clear status semantics', () => {
    renderAtlas({ status: 'loading' });
    expect(screen.getByRole('status')).toHaveTextContent('Finding the places your reading has reached');

    const onRetry = vi.fn();
    const { unmount } = render(<AtlasScreen state={{ status: 'unavailable', message: 'Connection interrupted.' }} onReturn={vi.fn()} onRetry={onRetry} onSetAside={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Connection interrupted.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
    unmount();
  });

  it('shows a truthful empty Atlas and returns to Universe', () => {
    const onReturn = vi.fn();
    renderAtlas({ status: 'loaded', response: atlasResponse({ places: [], relations: [], chronicle: [] }) }, { onReturn });
    expect(screen.getByRole('heading', { name: 'A place forms as you explore.' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Return to Universe' }));
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it('renders actual places, typed connections, room positions, demand, and chronicle without source metadata or counts', () => {
    renderAtlas({ status: 'loaded', response: atlasResponse() });
    const places = screen.getByLabelText('Places in your Atlas');
    expect(within(places).getByRole('heading', { name: 'Gravity' })).toBeInTheDocument();
    expect(within(places).getByRole('heading', { name: 'Orbits' })).toBeInTheDocument();
    expect(within(places).getByRole('heading', { name: 'On the horizon' })).toBeInTheDocument();
    expect(screen.getAllByText('Gravity explains Orbits')).toHaveLength(2);
    expect(screen.getByText('Being written: more about Gravity.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing more about Orbits for now/)).toBeInTheDocument();
    expect(screen.getAllByLabelText('More about this place')[1]).toHaveTextContent('The earlier Scroll was withdrawn after its basis changed.');
    expect(screen.getByText('Two readings disagree')).toBeInTheDocument();
    expect(screen.getAllByText('Gravity became a place through your reading.')).toHaveLength(2);
    expect(screen.queryByText(/PRIVATE SOURCE TITLE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sourceFamilies|Scrolls? read|3 of 8/)).not.toBeInTheDocument();
  });

  it('names a bound Scroll from the live demand without exposing its source', () => {
    const response = atlasResponse();
    const places = response.places.map((place) => place.placeId === regionId
      ? {
          ...place,
          demand: {
            demandId: '00000000-0000-4000-8000-000000000008',
            status: 'bound' as const,
            reason: null,
            scroll: { assetId: '00000000-0000-4000-8000-000000000009', title: 'A new reading' },
            withdrawn: false,
          },
        }
      : place);
    renderAtlas({ status: 'loaded', response: { ...response, places } });
    expect(screen.getByText('New for you: A new reading.')).toBeInTheDocument();
    expect(screen.queryByText('PRIVATE SOURCE TITLE')).not.toBeInTheDocument();
  });

  it('expands room positions and routes set-aside with the real identifier', () => {
    const onSetAside = vi.fn();
    renderAtlas({ status: 'loaded', response: atlasResponse() }, { onSetAside });
    const gravity = screen.getByRole('heading', { name: 'Gravity' }).closest('article');
    expect(gravity).not.toBeNull();
    const positions = within(gravity as HTMLElement).getByRole('button', { name: 'See positions' });
    expect(positions).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(positions);
    expect(screen.getByText('Mass changes how objects move.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide positions' }));
    expect(screen.queryByText('Mass changes how objects move.')).not.toBeInTheDocument();
    fireEvent.click(within(gravity as HTMLElement).getByRole('button', { name: 'Set this place aside' }));
    expect(onSetAside).toHaveBeenCalledWith(planetId);
    expect(screen.queryByRole('button', { name: /set.*Star formation aside/i })).not.toBeInTheDocument();
  });
});
