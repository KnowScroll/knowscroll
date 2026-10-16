import type { WebWorld } from '../world.ts';
import './environment-label.css';

const LABELS: Partial<Record<WebWorld, { name: string; detail: string }>> = {
  stage: { name: 'STAGE', detail: 'test universe · not yours' },
  dev: { name: 'DEV', detail: 'can be reset at any time' },
};

/** The Stage/Dev ribbon from #201's Gate 1 mockup. Live and local show nothing. It never takes a
 * tap: it sits above the page with pointer events off. */
export function EnvironmentLabel({ world }: { world: WebWorld }) {
  const label = LABELS[world];
  if (!label) return null;
  return (
    <div className={`environment-label environment-label-${world}`} role="note" aria-label="Environment">
      <strong>{label.name}</strong> <span>{label.detail}</span>
    </div>
  );
}
