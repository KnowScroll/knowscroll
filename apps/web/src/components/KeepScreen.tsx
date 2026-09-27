import { useEffect } from 'react';
import type { Trace } from '../api/types.ts';
import type { UniverseView } from '../state/readerStore.ts';
import { Compass } from './Compass.tsx';
import { CosmosBackground } from './CosmosBackground.tsx';

export function KeepScreen({ state, onReturn, onEnterScroll, onOpenTrace }: { state: UniverseView; onReturn: () => void; onEnterScroll: () => void; onOpenTrace: (trace: Trace) => void }) {
  useEffect(() => { const key = (event: KeyboardEvent) => { if(event.key === 'Escape') onReturn(); }; window.addEventListener('keydown',key); return () => window.removeEventListener('keydown',key); },[onReturn]);
  return <main className="keep-screen" aria-label="Keep"><CosmosBackground />
    <header className="cosmic-context"><button className="pill cream" onClick={onReturn}>‹ Universe</button><span className="eyebrow">Your collection</span></header>
    <section className="keep-content"><p className="eyebrow">Kept by you</p><h1>Worth coming back to.</h1><p className="keep-intro">Your saved Traces, with their original sources.</p>
      {state.status === 'loading' && <p role="status">Loading your Traces…</p>}
      {state.status === 'unavailable' && <p role="alert">{state.message}</p>}
      {state.status === 'loaded' && (!state.universe.traces.length ? <div className="keep-empty"><p>Nothing kept yet. When something stays with you, Keep it here.</p><button className="pill yellow" onClick={onEnterScroll}>Find something interesting ↗</button></div> : <ul className="keep-list">{state.universe.traces.map(trace => <li key={trace.eventId}><button onClick={() => onOpenTrace(trace)} aria-label={`Revisit the saved Trace: ${trace.title}`}><span className="trace-mark" aria-hidden="true">▱</span><span><strong>{trace.title || 'Saved Scroll unavailable'}</strong><time dateTime={trace.createdAt}>{new Date(trace.createdAt).toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'})}</time></span><span aria-hidden="true">↗</span></button></li>)}</ul>)}
    </section><Compass selected="keep" onAtlas={onReturn} onCable={onEnterScroll} onKeep={() => {}} />
  </main>;
}
