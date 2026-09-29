import { useState } from 'react';
import './branch-panel.css';

export interface BranchChoice {
  branchId: string;
  relationPhrase: string;
  toConcept: { name: string };
  mechanism: string;
  target: { title: string; summary: string };
  seen: boolean;
}

export interface BranchPanelProps {
  choices: readonly BranchChoice[];
  status: 'idle' | 'loading' | 'loaded' | 'opening' | 'unavailable';
  emptyReason?: string | null;
  error?: string | null;
  canReturn: boolean;
  canOpen: boolean;
  onExplore: () => void;
  onOpen: (branchId: string) => void;
  onReturn: () => void;
}

/** A continuation is an explicit reader choice. Listing can record offered-gap
 * demand, so merely rendering an encounter never fetches branches. */
export function BranchPanel({ choices, status, emptyReason, error, canReturn, canOpen, onExplore, onOpen, onReturn }: BranchPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const busy = status === 'loading' || status === 'opening';
  return (
    <section className="branch-panel" aria-label="Connections">
      <div className="branch-panel-head">
        <div>
          <p className="eyebrow">Another way through</p>
          <h3>Connections</h3>
        </div>
        <div className="branch-panel-actions">
          {canReturn && <button type="button" className="pill cream" onClick={onReturn} disabled={busy}>← Return to origin</button>}
          <button type="button" className="pill teal" aria-expanded={expanded} onClick={() => {
            if (!expanded) onExplore();
            setExpanded(value => !value);
          }}>
            {expanded ? 'Close connections' : 'Explore connections'}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="branch-panel-body">
          {status === 'loading' && <p role="status">Finding available connections…</p>}
          {status === 'opening' && <p role="status">Opening this connection…</p>}
          {status === 'unavailable' && <p role="alert">{error ?? 'Connections are unavailable.'} <button type="button" className="pill cream" onClick={onExplore}>Retry</button></p>}
          {status === 'loaded' && error && <p role="alert">{error} <button type="button" className="pill cream" onClick={onExplore}>Refresh connections</button></p>}
          {status === 'loaded' && choices.length === 0 && <p>No available connection from this encounter{emptyReason ? ` (${emptyReason.replaceAll('_', ' ')})` : ''}.</p>}
          {(status === 'loaded' || status === 'opening') && choices.length > 0 && (
            <ul className="branch-list">
              {choices.map(choice => (
                <li key={choice.branchId}>
                  <p className="branch-relation">{choice.relationPhrase} · {choice.toConcept.name}</p>
                  <h4>{choice.target.title}</h4>
                  <p>{choice.target.summary}</p>
                  <p className="branch-mechanism">{choice.mechanism}</p>
                  <button type="button" className="pill yellow" disabled={busy || !canOpen} onClick={() => onOpen(choice.branchId)}>
                    {choice.seen ? 'Revisit connection →' : 'Follow connection →'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
