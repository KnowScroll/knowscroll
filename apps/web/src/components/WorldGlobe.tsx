import { useId } from 'react';

/** Cartographic texture is decorative; it does not assert named regions or semantic growth. */
export function WorldGlobe({ variant = 0 }: { variant?: number }) {
  const id = useId().replaceAll(':', '');
  const coral = variant % 2 === 1;
  return <svg className="world-globe" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id={`${id}-sea`} cx="30%" cy="25%" r="80%">
        <stop stopColor={coral ? '#18a5ae' : '#19b6c1'} /><stop offset=".58" stopColor={coral ? '#19619b' : '#145087'} /><stop offset="1" stopColor="#07112e" />
      </radialGradient>
      <radialGradient id={`${id}-shade`} cx="30%" cy="25%" r="80%"><stop offset=".35" stopColor="#050b19" stopOpacity="0" /><stop offset="1" stopColor="#050b19" stopOpacity=".86" /></radialGradient>
      <clipPath id={`${id}-clip`}><circle cx="100" cy="100" r="89" /></clipPath>
    </defs>
    <circle cx="100" cy="100" r="97" fill="none" stroke="#2c46e8" strokeWidth="2" strokeOpacity=".65" />
    <circle cx="100" cy="100" r="89" fill={`url(#${id}-sea)`} />
    <g clipPath={`url(#${id}-clip)`}>
      <g fill="none" stroke="#fffdf2" strokeOpacity=".13" strokeWidth=".65">
        {[28,55,80].map(rx=><ellipse key={rx} cx="100" cy="100" rx={rx} ry="89" />)}
        {[45,73,101,129,157].map(y=><path key={y} d={`M 0 ${y} Q 100 ${y+26} 200 ${y}`} />)}
      </g>
      <g className="world-globe__surface">
        {[-200, 0, 200].map(offset => <g key={offset} transform={`translate(${offset} 0)`}>
          <g fill={coral ? '#48c6a5' : '#38bc9d'} stroke="#082c42" strokeWidth="2" strokeLinejoin="round" transform={coral ? 'rotate(130 100 100)' : undefined}>
            <path d="M20 47 43 31 68 34 81 48 92 57 80 71 55 78 39 68 24 72 16 60Z" />
            <path d="M111 26 137 25 158 40 162 58 145 68 122 62 106 48Z" />
            <path d="M101 84 124 80 145 91 162 105 151 124 160 143 143 173 120 167 103 150 110 128 92 107Z" />
            <path d="M13 111 41 106 59 122 62 144 45 165 23 166 10 141Z" />
            <path d="M76 96 86 108 81 128 69 119Z" />
          </g>
          <g fill="none" stroke="#e5ffed" strokeWidth="1.1" strokeOpacity=".36" transform={coral ? 'rotate(130 100 100)' : undefined}>
            <path d="m25 52 19-10 18 4 10 14-21 9M116 39l18-7 16 14-11 13M108 102l22-10 20 14-13 15 8 26-20 13M22 124l18-8 12 16-10 24" />
          </g>
        </g>)}
      </g>
      <g className="world-globe__clouds" fill="none" stroke="#e5ffff" strokeWidth="3" strokeLinecap="round" opacity=".22">
        <path d="M7 60 Q47 43 80 52 T156 47 M33 129 Q76 111 117 123 T204 111" />
        <path d="M4 66 Q44 49 79 58 T158 53 M32 135 Q77 117 118 129 T202 117" strokeWidth="1" />
      </g>
      <circle className="world-globe__twilight" cx="100" cy="100" r="89" fill="#ff8e7a" opacity="0" />
      <circle className="world-globe__night" cx="100" cy="100" r="89" fill="#061331" opacity="0" />
      <circle cx="100" cy="100" r="89" fill={`url(#${id}-shade)`} />
      <path d="M20 85 Q65 62 113 77 M99 153 Q145 165 185 134" fill="none" stroke="#fffdf2" strokeWidth="5" strokeOpacity=".12" />
    </g>
    <circle cx="100" cy="100" r="89" fill="none" stroke="#7ce9ff" strokeWidth="2.4" strokeOpacity=".82" />
  </svg>;
}
