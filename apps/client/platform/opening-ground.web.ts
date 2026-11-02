import { useEffect } from 'react';

/**
 * Web: while the Universe's first open is being prepared or plays, the page itself is the opening's dark
 * ground, so no white page shows between the app's first frame and the picture's. It gives the colours back
 * when the opening is over, so the other tabs keep their own paper.
 */
export function useOpeningGround(dark: boolean, colour: string): void {
  useEffect(() => {
    if (!dark) return;
    const page = document.documentElement;
    const body = document.body;
    const before = [page.style.backgroundColor, body.style.backgroundColor] as const;
    page.style.backgroundColor = colour;
    body.style.backgroundColor = colour;
    return () => {
      page.style.backgroundColor = before[0];
      body.style.backgroundColor = before[1];
    };
  }, [dark, colour]);
}
