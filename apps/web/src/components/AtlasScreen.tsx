import { useState } from 'react';
import type { WebAtlasResponse as AtlasResponse } from '../../../../packages/contracts/src/atlas.ts';
import './atlas-screen.css';

export type AtlasScreenState =
  | { status: 'loading' }
  | { status: 'loaded'; response: AtlasResponse; settingAside?: string | null; error?: string | null }
  | { status: 'unavailable'; message: string };

export interface AtlasScreenProps {
  state: AtlasScreenState;
  onReturn: () => void;
  onRetry: () => void;
  onSetAside: (placeId: string) => void;
}

const relationWords: Record<AtlasResponse['relations'][number]['kind'], string> = {
  prerequisite_for: 'comes before',
  explains: 'explains',
  contradicts: 'is in tension with',
  analogous_in: 'works like',
  applies_to: 'applies to',
  compares_mechanism: 'can be compared with',
};

type CannotMeetReason = Exclude<NonNullable<AtlasResponse['places'][number]['demand']>['reason'], null>;

const demandReasons: Record<CannotMeetReason, string> = {
  no_route: 'Nothing is set up to write more yet.',
  no_budget: 'Writing more has reached its limit for now.',
  no_material: 'There is no material to write more from yet.',
  checks_failed: 'What was written did not pass its checks.',
  request_failed: 'The last attempt did not finish.',
};

function demandCopy(place: AtlasResponse['places'][number]): string | null {
  const demand = place.demand;
  if (!demand) return null;
  let state: string;
  if (demand.status === 'waiting') {
    state = `Being written: more about ${place.anchor.name}.`;
  } else if (demand.status === 'bound' && demand.scroll) {
    state = `New for you: ${demand.scroll.title}.`;
  } else if (demand.status === 'cannot_meet' && demand.reason) {
    state = `Nothing more about ${place.anchor.name} for now. ${demandReasons[demand.reason]}`;
  } else {
    state = `The request for more about ${place.anchor.name} has an unknown state.`;
  }
  return demand.withdrawn ? `${state} The earlier Scroll was withdrawn after its basis changed.` : state;
}

function Place({ place, response, settingAside, onSetAside }: {
  place: AtlasResponse['places'][number];
  response: AtlasResponse;
  settingAside?: string | null;
  onSetAside: (placeId: string) => void;
}) {
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(null);
  const connected = response.relations.filter(
    (relation) => relation.fromPlaceId === place.placeId || relation.toPlaceId === place.placeId,
  );
  const otherName = (id: string) => response.places.find((candidate) => candidate.placeId === id)?.anchor.name;
  const demand = demandCopy(place);
  const relatedChanges = response.chronicle.filter(
    (entry) => entry.placeId === place.placeId || entry.parentPlaceId === place.placeId,
  );

  return (
    <article className={`atlas-place atlas-place-${place.kind}`}>
      <div className="atlas-place-heading">
        <span className={`atlas-kind atlas-kind-${place.kind}`}>{place.kind === 'planet' ? 'Place' : place.kind === 'region' ? 'Region' : 'On the horizon'}</span>
        {place.foundation && <span className="atlas-foundation">Holds other places up</span>}
        {place.rooms.length > 0 && <span className="atlas-room-mark" aria-label="Has an idea room">Room</span>}
      </div>
      <h2>{place.anchor.name}</h2>
      <p className="atlas-description">{place.anchor.description}</p>

      {place.basis && place.kind === 'sighting' && (
        <p className="atlas-basis">{place.basis.from} {relationWords[place.basis.kind]} {place.basis.to}</p>
      )}

      {connected.length > 0 && (
        <section className="atlas-place-section" aria-label={`Connections from ${place.anchor.name}`}>
          <h3>Connections</h3>
          <ul className="atlas-connection-list">
            {connected.map((relation) => {
              const forward = relation.fromPlaceId === place.placeId;
              const other = otherName(forward ? relation.toPlaceId : relation.fromPlaceId);
              if (!other) return null;
              return <li key={`${relation.fromPlaceId}-${relation.toPlaceId}-${relation.kind}`}>
                <span>{forward ? place.anchor.name : other} {relationWords[relation.kind]} {forward ? other : place.anchor.name}</span>
                {relation.claim && <q>{relation.claim.text}</q>}
                {relation.bridge && <q>{relation.bridge.mechanism}</q>}
              </li>;
            })}
          </ul>
        </section>
      )}

      {place.foundation && (
        <section className="atlas-place-section">
          <h3>What this place holds up</h3>
          <ul className="atlas-connection-list">
            {place.foundation.relations.map((relation) => (
              <li key={`${relation.from}-${relation.to}-${relation.kind}`}>
                {relation.from} {relationWords[relation.kind]} {relation.to}
                {relation.claim && <q>{relation.claim.text}</q>}
                {relation.bridge && <q>{relation.bridge.mechanism}</q>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {place.rooms.length > 0 && (
        <section className="atlas-place-section atlas-rooms">
          <h3>Idea rooms</h3>
          {place.rooms.map((room) => (
            <div className="atlas-room" key={room.roomId}>
              <p className="atlas-room-state">{room.state === 'arguing' ? 'Two readings disagree' : 'A question carried here'}</p>
              <p className="atlas-room-question">{room.question}</p>
              {expandedRoomId === room.roomId && <ul className="atlas-seat-list">
                {room.inhabitants.map((seat) => (
                  <li key={seat.role}>
                    <span>{seat.role === 'reader_of_record' ? 'Reader of record' : seat.role === 'doubter' ? 'Doubter' : 'Connector'}</span>
                    {seat.claims.map((claim) => <q key={claim.key}>{claim.statement}</q>)}
                  </li>
                ))}
              </ul>}
              <button type="button" className="atlas-text-button" aria-expanded={expandedRoomId === room.roomId} onClick={() => setExpandedRoomId(expandedRoomId === room.roomId ? null : room.roomId)}>
                {expandedRoomId === room.roomId ? 'Hide positions' : 'See positions'}
              </button>
            </div>
          ))}
        </section>
      )}

      {demand && <p className="atlas-demand" aria-label="More about this place">{demand}</p>}

      {relatedChanges.length > 0 && (
        <section className="atlas-place-section atlas-place-chronicle">
          <h3>Recent changes</h3>
          <ul>{relatedChanges.slice(0, 3).map((entry) => <li key={entry.deltaId}>{entry.line}</li>)}</ul>
        </section>
      )}

      {place.kind !== 'sighting' && (
        <button type="button" className="atlas-set-aside" disabled={settingAside !== null && settingAside !== undefined} onClick={() => onSetAside(place.placeId)}>
          {settingAside === place.placeId ? 'Setting aside…' : 'Set this place aside'}
        </button>
      )}
    </article>
  );
}

export function AtlasScreen({ state, onReturn, onRetry, onSetAside }: AtlasScreenProps) {
  return (
    <main className="atlas-screen" aria-label="Atlas">
      <div className="atlas-frame">
        <header className="atlas-header">
          <button type="button" className="atlas-back" onClick={onReturn} aria-label="Return to Universe">‹ Universe</button>
          <p className="atlas-kicker">KnowScroll · your places</p>
        </header>
        <section className="atlas-content" aria-labelledby="atlas-title" aria-busy={state.status === 'loading'}>
          <p className="atlas-overline">A map of where your reading has reached</p>
          <h1 id="atlas-title">Your Atlas.</h1>
          {state.status === 'loading' && (
            <div className="atlas-state" role="status" aria-live="polite">
              <span className="atlas-loading-mark" aria-hidden="true" />
              <p>Finding the places your reading has reached…</p>
            </div>
          )}
          {state.status === 'unavailable' && (
            <div className="atlas-state atlas-error" role="alert">
              <h2>Your Atlas is unavailable</h2>
              <p>{state.message}</p>
              <button type="button" className="atlas-action" onClick={onRetry}>Try again</button>
            </div>
          )}
          {state.status === 'loaded' && state.response.places.length === 0 && (
            <div className="atlas-state atlas-empty">
              <p className="atlas-empty-orbit" aria-hidden="true">·</p>
              <h2>A place forms as you explore.</h2>
              <p>Read a Scroll and return when your Atlas has taken shape.</p>
            </div>
          )}
          {state.status === 'loaded' && state.response.places.length > 0 && (
            <>
              {state.error && <p className="atlas-action-error" role="alert">{state.error}</p>}
              {state.settingAside && <p className="atlas-action-status" role="status">Setting this place aside…</p>}
              <p className="atlas-intro">These places and connections come from your reading.</p>
              <section className="atlas-place-list" aria-label="Places in your Atlas">
                {state.response.places.filter((place) => place.kind !== 'sighting').map((place) => (
                  <Place key={place.placeId} place={place} response={state.response} settingAside={state.settingAside} onSetAside={onSetAside} />
                ))}
                {state.response.places.some((place) => place.kind === 'sighting') && (
                  <section className="atlas-horizon" aria-labelledby="atlas-horizon-title">
                    <p className="atlas-overline">At the edge of places you reached</p>
                    <h2 id="atlas-horizon-title">On the horizon</h2>
                    {state.response.places.filter((place) => place.kind === 'sighting').map((place) => (
                      <Place key={place.placeId} place={place} response={state.response} settingAside={state.settingAside} onSetAside={onSetAside} />
                    ))}
                  </section>
                )}
              </section>
              {state.response.chronicle.length > 0 && (
                <section className="atlas-chronicle" aria-labelledby="atlas-chronicle-title">
                  <p className="atlas-overline">Kept as it happened</p>
                  <h2 id="atlas-chronicle-title">Chronicle</h2>
                  <ol>{state.response.chronicle.map((entry) => <li key={entry.deltaId}><time dateTime={entry.at}>{new Date(entry.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time><span>{entry.line}</span></li>)}</ol>
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
