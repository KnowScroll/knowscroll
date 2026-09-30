import './representation-switch.css';

export function RepresentationSwitch({ selected, onSelect, disabled = false }: {
  selected: 'Reel' | 'Scroll';
  onSelect: (kind: 'Reel' | 'Scroll') => void;
  disabled?: boolean;
}) {
  return <div className="representation-switch" role="group" aria-label="Reel or Scroll">
    {(['Reel', 'Scroll'] as const).map(kind => <button
      key={kind}
      type="button"
      className={selected === kind ? 'is-selected' : ''}
      aria-pressed={selected === kind}
      disabled={disabled && selected !== kind}
      onClick={() => { if (selected !== kind) onSelect(kind); }}
    >{kind}</button>)}
  </div>;
}
