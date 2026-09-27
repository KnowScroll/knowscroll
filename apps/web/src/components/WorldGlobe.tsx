import { useId } from 'react';

/** Cartographic texture is decorative; it does not assert named regions or semantic growth. */
export function WorldGlobe({ variant = 0 }: { variant?: number }) {
  const id = useId().replaceAll(':', '');
  const coral = variant % 2 === 1;
  return <svg className="world-globe" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id={`${id}-sea`} cx="30%" cy="25%" r="80%">
        <stop stopColor={coral ? '#d99d7e' : '#438a90'} /><stop offset=".65" stopColor={coral ? '#735653' : '#17505f'} /><stop offset="1" stopColor="#03101a" />
      </radialGradient>
      <radialGradient id={`${id}-shade`} cx="30%" cy="25%" r="80%"><stop offset=".35" stopColor="#03101a" stopOpacity="0" /><stop offset="1" stopColor="#03101a" stopOpacity=".8" /></radialGradient>
      <clipPath id={`${id}-clip`}><circle cx="100" cy="100" r="89" /></clipPath>
    </defs>
    <circle cx="100" cy="100" r="96" fill="none" stroke="#8fe9e4" strokeOpacity=".12" />
    <circle cx="100" cy="100" r="89" fill={`url(#${id}-sea)`} />
    <g clipPath={`url(#${id}-clip)`}>
      <g fill="none" stroke="#fffdf2" strokeOpacity=".13" strokeWidth=".65">
        {[28,55,80].map(rx=><ellipse key={rx} cx="100" cy="100" rx={rx} ry="89" />)}
        {[45,73,101,129,157].map(y=><path key={y} d={`M 0 ${y} Q 100 ${y+26} 200 ${y}`} />)}
      </g>
      <g fill={coral ? '#e5bc92' : '#83beb4'} stroke="#092b34" strokeWidth="3" strokeLinejoin="round" transform={coral ? 'rotate(130 100 100)' : undefined}>
        <path d="M22 49 47 36 74 42 86 60 76 75 52 79 35 66Z" />
        <path d="M113 30 134 27 153 44 149 60 129 69 112 56Z" />
        <path d="M104 92 132 82 157 102 147 130 157 148 141 177 110 166 99 145 108 123 94 108Z" />
        <path d="M18 113 43 110 62 131 54 156 34 168 15 145Z" />
        <path d="M77 103 85 112 82 127 72 119Z" />
      </g>
      <circle cx="100" cy="100" r="89" fill={`url(#${id}-shade)`} />
      <path d="M20 85 Q65 62 113 77 M99 153 Q145 165 185 134" fill="none" stroke="#fffdf2" strokeWidth="5" strokeOpacity=".12" />
    </g>
    <circle cx="100" cy="100" r="89" fill="none" stroke="#8fe9e4" strokeOpacity=".35" />
  </svg>;
}
