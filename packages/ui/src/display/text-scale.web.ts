import { useEffect, useState } from 'react';

/** What browsers call 100 %: the default size of the page's own text. */
const DEFAULT_ROOT_PX = 16;

function readRootScale(): number {
  if (typeof document === 'undefined') return 1;
  const size = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? Math.max(1, Math.round((size / DEFAULT_ROOT_PX) * 100) / 100) : 1;
}

/**
 * The browser's text size setting. React Native Web reports a font scale of 1 always, so the app
 * reads the root font size instead (the browser's "font size" preference, or a user style sheet) and
 * resizes its own text by the same 200 % rules native uses. Page zoom needs none of this: it
 * changes the window width, which the breakpoints already follow. Read again when the window is
 * resized or focused, because a browser setting raises no event of its own.
 */
export function useSystemTextScale(fontScale: number): number {
  const [rootScale, setRootScale] = useState(readRootScale);
  useEffect(() => {
    const update = () => setRootScale(readRootScale());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('focus', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('focus', update);
    };
  }, []);
  return fontScale * rootScale;
}
