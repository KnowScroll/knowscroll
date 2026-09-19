import type { Trace } from '../api/types.ts';
import type { UniverseView } from '../state/readerStore.ts';
import { CosmosBackground } from './CosmosBackground.tsx';

export interface UniverseScreenProps {
  state: UniverseView;
  onEnterScroll: () => void;
  onOpenTrace: (trace: Trace) => void;
  onRetry: () => void;
}

export function UniverseScreen({ state, onEnterScroll, onOpenTrace, onRetry }: UniverseScreenProps) {
  return (
    <main className="universe-screen" aria-label="Universe">
      <CosmosBackground />
      <div className="universe-content">
        <p className="eyebrow">KNOWSCROLL</p>
        <h1>Your universe</h1>
        {state.status === 'loading' && (
          <p role="status" aria-live="polite">
            Loading your universe…
          </p>
        )}
        {state.status === 'unavailable' && (
          <div className="unavailable-block" role="alert">
            <h2>The universe is unavailable</h2>
            <p>The bootstrap service could not be reached, or this session is no longer valid.</p>
            <p className="detail">{state.message}</p>
            <button type="button" onClick={onRetry} aria-label="Retry loading the universe">
              Retry
            </button>
          </div>
        )}
        {state.status === 'loaded' && (
          <LoadedUniverse universe={state.universe.traces} onEnterScroll={onEnterScroll} onOpenTrace={onOpenTrace} />
        )}
      </div>
    </main>
  );
}

function LoadedUniverse({
  universe,
  onEnterScroll,
  onOpenTrace,
}: {
  universe: Trace[];
  onEnterScroll: () => void;
  onOpenTrace: (trace: Trace) => void;
}) {
  return (
    <div className="universe-loaded">
      {universe.length === 0 ? (
        <p className="empty-universe">
          Nothing lives here yet. Enter Scroll to have your first sourced encounter — nothing has been inferred about
          you, and no interests have been assumed.
        </p>
      ) : (
        <nav aria-label="Saved Traces">
          <p className="eyebrow">Saved Traces</p>
          <ul className="trace-list">
            {universe.map(trace => (
              <li key={trace.eventId}>
                <button
                  type="button"
                  className="trace-card"
                  onClick={() => onOpenTrace(trace)}
                  aria-label={`Revisit the saved Trace: ${trace.title || 'Saved Scroll unavailable'}`}
                >
                  <span className="trace-dot" aria-hidden="true" />
                  <span className="trace-text">
                    <span className="trace-title">{trace.title || 'Saved Scroll unavailable'}</span>
                    <span className="trace-date">{trace.createdAt}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <button type="button" className="primary enter-scroll" onClick={onEnterScroll} aria-label="Enter Scroll">
        Enter Scroll
      </button>
    </div>
  );
}
