export function Compass({ selected, onCable, onAtlas, onKeep }: { selected?: 'cable' | 'atlas' | 'keep'; onCable: () => void; onAtlas: () => void; onKeep: () => void }) {
  return <nav className="universe-dock" aria-label="Main navigation">
    {([{key:'cable',label:'Cable',icon:'〜',description:'read a Scroll',action:onCable},{key:'atlas',label:'Atlas',icon:'◎',description:'your universe',action:onAtlas},{key:'keep',label:'Keep',icon:'▱',description:'your saved Traces',action:onKeep}] as const).map(item => <button key={item.key} type="button" className={`dock-button ${selected === item.key ? 'current' : ''}`} aria-current={selected === item.key ? 'page' : undefined} onClick={item.action} aria-label={`${item.label} — ${item.description}`}><span className="dock-icon" aria-hidden="true">{item.icon}</span>{item.label}</button>)}
  </nav>;
}
