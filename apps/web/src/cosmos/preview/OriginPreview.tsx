import { useEffect, useMemo, useRef, useState } from 'react';
import { UniverseScreen } from '../../components/UniverseScreen.tsx';
import { CosmosBackground } from '../../components/CosmosBackground.tsx';
import { MemoryStorageBackend, ReaderStorage } from '../../state/storage.ts';
import { chooseQuality, OriginRenderer } from '../gl/OriginRenderer.ts';
import { SkySurface } from '../SkySurface.tsx';
import { ACTS, captionAt, ORIGIN_DURATION } from '../timeline.ts';
import { usePrefersReducedMotion } from '../usePrefersReducedMotion.ts';
import { conditionsFixture } from './fixtures.ts';
import { deriveSky } from '../starView.ts';
import './preview.css';

type Tab = 'opening' | 'conditions' | 'perspective';

/**
 * The isolated cosmos preview (ADR-0049). Not the reader's universe: it runs without the API, on
 * illustrative fixtures, and labels itself on every view. It holds what review needs and the
 * product does not yet do: a scrubber over the opening, every star condition side by side (real
 * data cannot yet reach "tense" or "lights others"), and the proposed perspective-world release
 * of ADR-0049 §6, which is not implemented.
 */
export function OriginPreview() {
  const initial = (new URLSearchParams(window.location.search).get('view') as Tab | null) ?? 'opening';
  const [tab, setTab] = useState<Tab>(['opening', 'conditions', 'perspective'].includes(initial) ? initial : 'opening');
  return (
    <div className="cosmos-preview" data-view={tab}>
      <header className="cosmos-preview__bar">
        <p className="cosmos-preview__label">Preview · illustrative, not your universe</p>
        <nav aria-label="Preview views" className="cosmos-preview__tabs">
          {([['opening', 'The opening'], ['conditions', 'Star conditions'], ['perspective', 'Proposed: a perspective world']] as const).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
      </header>
      {tab === 'opening' && <OpeningScrubber />}
      {tab === 'conditions' && <ConditionsGallery />}
      {tab === 'perspective' && <PerspectiveProposal />}
    </div>
  );
}

function OpeningScrubber() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const params = new URLSearchParams(window.location.search);
  const fixed = params.get('t');
  const [t, setT] = useState(fixed ? Number(fixed) : 0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rendererRef = useRef<OriginRenderer | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const canvas = document.createElement('canvas');
    canvas.className = 'origin-canvas';
    host.appendChild(canvas);
    let renderer: OriginRenderer;
    try {
      renderer = new OriginRenderer(canvas, chooseQuality(window.innerWidth, window.innerHeight));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      canvas.remove();
      return undefined;
    }
    rendererRef.current = renderer;
    const size = () => {
      renderer.resize(host.clientWidth, host.clientHeight, window.devicePixelRatio);
      renderer.seedTarget = { x: host.clientWidth / 2, y: host.clientHeight * 0.5, radius: 66 };
      renderer.render(tRef.current, tRef.current);
    };
    size();
    window.addEventListener('resize', size);
    (window as unknown as { __origin?: unknown }).__origin = { render: (time: number) => renderer.render(time, time) };
    return () => {
      window.removeEventListener('resize', size);
      renderer.dispose();
      canvas.remove();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!playing) {
      rendererRef.current?.render(t, t);
      return undefined;
    }
    let raf = 0;
    const start = performance.now() - t * 1000;
    const loop = (now: number) => {
      const time = (now - start) / 1000;
      if (time > ORIGIN_DURATION) {
        setPlaying(false);
        return;
      }
      rendererRef.current?.render(time, time);
      setT(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const caption = captionAt(t);
  const act = ACTS.find(item => t >= item.start && t < item.end) ?? ACTS[ACTS.length - 1]!;
  return (
    <section className="cosmos-preview__opening" aria-label="The opening, frame by frame">
      <div ref={hostRef} className="cosmos-preview__stage" aria-hidden="true" />
      {caption.text && <p className="origin-caption cosmos-preview__caption" style={{ opacity: caption.opacity }}>{caption.text}</p>}
      {error && <p className="cosmos-preview__error" role="alert">WebGL could not start: {error}</p>}
      <div className="cosmos-preview__scrub">
        <button type="button" onClick={() => setPlaying(value => !value)}>{playing ? 'Pause' : 'Play'}</button>
        <input type="range" min={0} max={ORIGIN_DURATION} step={0.05} value={t} onChange={event => { setPlaying(false); setT(Number(event.target.value)); }} aria-label="Time in the opening" />
        <span className="cosmos-preview__time">{t.toFixed(1)} s · {act.label}</span>
      </div>
      <div className="cosmos-preview__acts">
        {ACTS.map(item => <button key={item.id} type="button" aria-pressed={act.id === item.id} onClick={() => { setPlaying(false); setT(item.start + 0.02); }}>{item.label}</button>)}
      </div>
    </section>
  );
}

function ConditionsGallery() {
  const reducedMotion = usePrefersReducedMotion();
  const fixture = useMemo(() => conditionsFixture(), []);
  const changes = useMemo(() => deriveSky(fixture).transformations.filter(item => item.starId !== null && item.kind !== 'quiet_change'), [fixture]);
  // Each replay remounts the Universe on fresh in-memory display memory that has drawn every change
  // but the chosen one, so exactly that change plays, as it would after it was recorded.
  const [replay, setReplay] = useState<{ id: string | null; run: number }>({ id: null, run: 0 });
  const storage = useMemo(() => {
    const memory = new ReaderStorage(new MemoryStorageBackend());
    if (replay.id) memory.writeSkyPlayed('preview', new Set(changes.map(item => item.id).filter(id => id !== replay.id)));
    return memory;
  }, [replay, changes]);
  return (
    <section className="cosmos-preview__universe" aria-label="Every star condition, on an illustrative fixture">
      <UniverseScreen
        key={replay.run}
        state={{ status: 'loaded', universe: { universeId: 'preview', revision: 1, privacyEpoch: 1, recordingPausedAt: null, traces: [], capabilities: { reasoning: false, reels: false, worldEvolution: false } } }}
        storage={storage}
        sky={{ status: 'loaded', response: fixture, settingAside: null, error: null }}
        reducedMotion={reducedMotion}
        onEnterScroll={() => undefined}
        onOpenTrace={() => undefined}
        onEnterSystem={() => undefined}
        onOpenPrivacy={() => undefined}
        onRetry={() => undefined}
      />
      <details className="cosmos-preview__legend" open={window.innerWidth > 860}>
        <summary>On this fixture</summary>
        <ul>
          <li><strong>Tides</strong> is quiet: no world has unfolded inside it; three possibilities wait at its edge.</li>
          <li><strong>Gravity</strong> is taking shape: a world (Orbit) and a question formed inside it.</li>
          <li><strong>Energy</strong> is under tension: a contradiction and an argued question.</li>
          <li><strong>Light</strong> lights others: sourced connections say it holds up three places.</li>
        </ul>
        <p>Tap a star to approach it. Reading is disabled here.</p>
        <p className="cosmos-preview__replay-label">Replay a recorded change as it plays once:</p>
        <div className="cosmos-preview__replays">
          {changes.slice(0, 4).map(item => (
            <button key={item.id} type="button" onClick={() => setReplay(current => ({ id: item.id, run: current.run + 1 }))}>
              {REPLAY_LABEL[item.kind] ?? item.kind}
            </button>
          ))}
        </div>
      </details>
    </section>
  );
}

const REPLAY_LABEL: Record<string, string> = {
  luminous: 'Light starts to light others',
  world_formed: 'Orbit forms inside Gravity',
  question_world: 'A question world forms',
  star_ignited: 'A star ignites',
  possibility: 'A possibility appears',
};

const STEPS = [
  { at: 0, title: 'Gravity, taking shape', body: 'One world (Orbit) and one question formed from your own reading.' },
  { at: 2600, title: 'You object to a claim you kept', body: 'An act, not a view: you disagreed with “gravity is a force pulling things together” on an encounter you had kept.' },
  { at: 5200, title: 'A sourced alternative exists', body: 'The substrate holds a cited, competing account of the same claim. Tension builds in the star.' },
  { at: 7600, title: 'The star releases material', body: 'A shell of material leaves the star. Nothing is destroyed: Orbit and your question stay where they are.' },
  { at: 10400, title: 'A perspective world forms beside the first', body: '“Curved spacetime” — another way of understanding Gravity. It sits beside your original reading; neither is marked correct.' },
] as const;

/** ADR-0049 §6, proposed and not implemented: drawn so it can be judged before anything is built. */
function PerspectiveProposal() {
  const reducedMotion = usePrefersReducedMotion();
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const [step, setStep] = useState(0);
  const [run, setRun] = useState(0);
  useEffect(() => {
    setStep(0);
    if (reducedMotion) return undefined;
    const timers = STEPS.slice(1).map((item, i) => setTimeout(() => setStep(i + 1), item.at));
    return () => timers.forEach(clearTimeout);
  }, [run, reducedMotion]);
  const condition = step >= 3 ? 'luminous' : step >= 2 ? 'tense' : 'stirring';
  const released = step >= 4;
  return (
    <section className="cosmos-preview__proposal" aria-label="Proposed: a perspective world is released">
      <CosmosBackground />
      <div className="cosmos-preview__field" ref={fieldRef}>
        <SkySurface anchors={fieldRef} reducedMotion={reducedMotion} />
        <svg className="star-system__orbits" viewBox="0 0 100 100" aria-hidden="true">
          <ellipse cx="50" cy="50" rx="18" ry="7.6" />
          <ellipse cx="50" cy="50" rx="31" ry="13" />
          {released && <ellipse cx="50" cy="50" rx="42" ry="17.6" className="is-new" />}
        </svg>
        <div className="cosmos-preview__body" style={{ left: '50%', top: '50%' }} data-sky="star" data-condition={condition} data-radius="40" data-seed="0.37" data-emphasis="1">
          <span className="sky-body__css sky-body__css--star" data-condition={condition} aria-hidden="true" />
        </div>
        <div className="cosmos-preview__body is-world" style={{ left: '68%', top: '52%' }} data-sky="world" data-world="facet" data-radius="13" data-seed="0.2">
          <span className="sky-label"><span className="sky-label__name">Orbit</span><span className="sky-label__sub">A world</span></span>
        </div>
        <div className="cosmos-preview__body is-world" style={{ left: '27%', top: '60%' }} data-sky="world" data-world="question" data-radius="11" data-seed="0.6">
          <span className="sky-label"><span className="sky-label__name">Why does the Moon not fall?</span><span className="sky-label__sub">A question</span></span>
        </div>
        {released && (
          <div className="cosmos-preview__body is-world is-new" style={{ left: '88%', top: '44%' }} data-sky="world" data-world="facet" data-radius="15" data-seed="0.9">
            <span className="sky-label"><span className="sky-label__name">Curved spacetime</span><span className="sky-label__sub">A perspective · proposed</span></span>
          </div>
        )}
      </div>
      <aside className="cosmos-preview__steps" aria-live="polite">
        <p className="cosmos-preview__label">Proposed · ADR-0049 §6 · not implemented</p>
        <ol>
          {STEPS.map((item, i) => (
            <li key={item.title} aria-current={i === step ? 'step' : undefined} className={i <= step ? 'is-on' : undefined}>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </li>
          ))}
        </ol>
        {released && (
          <dl className="cosmos-preview__delta">
            <dt>Would be recorded as</dt><dd><code>world_released</code>, cause <code>personal_exploration</code></dd>
            <dt>Evidence</dt><dd>the objection, the kept encounter it was made on, the cited alternative</dd>
            <dt>Never from</dt><dd>watch time, view counts, streaks or time away</dd>
          </dl>
        )}
        <div className="cosmos-preview__step-actions">
          {reducedMotion && step < STEPS.length - 1 && <button type="button" onClick={() => setStep(value => value + 1)}>Next step</button>}
          <button type="button" onClick={() => setRun(value => value + 1)}>Replay</button>
        </div>
      </aside>
    </section>
  );
}
