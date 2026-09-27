import { useEffect, useRef, useState } from 'react';
import type { WorldSummary } from '../api/types.ts';
import type { SystemView } from '../state/readerStore.ts';
import { CosmosBackground } from './CosmosBackground.tsx';
import { WorldGlobe } from './WorldGlobe.tsx';
import { Compass } from './Compass.tsx';

export interface SystemScreenProps {
  state: SystemView;
  onReturn: () => void;
  onRetry: () => void;
  onEnterScroll: () => void;
  onOpenKeep?: () => void;
}

export function SystemScreen({ state, onReturn, onRetry, onEnterScroll, onOpenKeep = onReturn }: SystemScreenProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastWorldId = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const lastWorld = useRef<HTMLButtonElement | null>(null);
  const worlds = state.status === 'loaded' ? state.response.system?.worlds ?? [] : [];
  const selected = worlds.find(world => world.worldId === selectedId);
  const back = () => {
    if (selected) { setSelectedId(null); requestAnimationFrame(() => lastWorld.current?.focus()); }
    else onReturn();
  };
  useEffect(() => {
    if (selectedId) heading.current?.focus();
  }, [selectedId]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'Escape' || event.key === 'Home') { event.preventDefault(); back(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  return <main className={`system-screen observatory ${selected ? 'world-focused' : ''}`} aria-label={selected ? 'World' : 'System'}>
    <CosmosBackground />
    <header className="cosmic-context">
      <button className="pill cream" onClick={back} aria-label={selected ? 'Return to system' : 'Return to Universe'}>‹ {selected ? 'Your system' : 'Universe'}</button>
      <span className="eyebrow">Your atlas / {selected ? 'World' : 'System'}</span>
    </header>
    <section className="observatory-content">
      {(state.status === 'idle' || state.status === 'loading') && <div className="system-empty" role="status"><h2>Finding your worlds…</h2><p>Gathering the places your reading has reached.</p></div>}
      {state.status === 'unavailable' && <div className="system-empty" role="alert"><h2>Your system is unavailable</h2><p>{state.message}</p><button className="pill orange" onClick={onRetry}>Retry</button></div>}
      {state.status === 'loaded' && !worlds.length && <div className="system-empty"><p className="eyebrow">A beginning</p><h2>Your first world is waiting.</h2><p>Read a Scroll and its source will become a place in your atlas.</p><button className="pill yellow" onClick={onEnterScroll}>Show me something ↗</button></div>}
      {worlds.length > 0 && !selected && <>
        <div className="observatory-intro"><p className="eyebrow">The places you have reached</p><h1>Your system.</h1><p>{worlds.length} {worlds.length === 1 ? 'world' : 'worlds'}, connected by your exploration.</p><p className="growth-caption">Each world begins with a source you encountered.</p></div>
        <div className={`world-map ${worlds.length > 4 ? 'world-map-many' : ''}`} role="list" aria-label="Worlds in your system">
          <div className="orbit-lines" aria-hidden="true"><i /><i /><i /></div>
          {worlds.map((world, index) => <div role="listitem" className="world-stop" key={world.worldId}>
            <button className="world-select" ref={node => { if (world.worldId === lastWorldId.current) lastWorld.current = node; }} onClick={event => { lastWorldId.current = world.worldId; lastWorld.current = event.currentTarget; setSelectedId(world.worldId); }} aria-label={`Explore world: ${world.sourceTitle}`}>
              <WorldGlobe variant={index} /><span className="world-name">{world.sourceTitle}</span><span className="world-status">{world.seenCount} of {world.scrollCount} Scrolls encountered</span>
            </button>
          </div>)}
        </div>
        <p className="map-invitation">Choose a world to take a closer look.</p>
      </>}
      {selected && <div className="world-detail" key={selected.worldId}>
        <div className="world-portrait"><WorldGlobe variant={worlds.indexOf(selected)} /></div>
        <div className="world-story"><p className="eyebrow">A source-backed world</p><h1 ref={heading} tabIndex={-1}>{selected.sourceTitle}</h1>
          <p className="world-encounter-count"><strong>{selected.seenCount}</strong> / {selected.scrollCount} Scrolls encountered</p>
          <p>{encounterCaption(selected)}</p>
          <p className="detail-explanation">This world gathers Scrolls from the same source. It appeared because your reading reached that source. Encounters record what was shown, not what you know.</p>
          <a className="pill teal" href={selected.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open source: ${selected.sourceTitle} (opens in a new tab)`}>Open source ↗</a>
          <p className="world-source-address">{sourceHost(selected.sourceUrl)}</p>
        </div>
      </div>}
    </section>
    <Compass selected="atlas" onAtlas={onReturn} onCable={onEnterScroll} onKeep={onOpenKeep} />
  </main>;
}
function encounterCaption(world: WorldSummary) {
  const remaining = Math.max(0, world.scrollCount - world.seenCount);
  return remaining ? `${remaining} ${remaining === 1 ? 'Scroll remains' : 'Scrolls remain'} to encounter in this source.` : 'All currently available Scrolls from this source have been encountered. A subject always holds more than its current library.';
}

function sourceHost(url: string) { try { return new URL(url).hostname; } catch { return 'Source address unavailable'; } }
