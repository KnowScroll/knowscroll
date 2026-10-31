import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Platform, type ScrollViewInstance, type HostInstance } from 'react-native';

/** How long the original stays lit after a jump (T3 kit: 1.2 s), and how long its outline stays under reduced motion. */
export const FLASH_MS = 1_200;
export const FLASH_OUTLINE_MS = 3_000;
/** How many pages of older messages a jump loads while it looks for an original that is not on screen. */
const MAX_OLDER_PAGES = 5;

/** What the screen's older-history control offers a jump that has to look further back. */
export interface OlderHistory {
  /** Read again after each page, so it reflects what the controller holds now. */
  readonly hasOlder: () => boolean;
  readonly loadOlder: () => Promise<void>;
}

function scrollToRow(scroll: ScrollViewInstance | null, row: HostInstance | null, animated: boolean): void {
  if (scroll === null || row === null) return;
  if (Platform.OS === 'web') {
    (row as unknown as { scrollIntoView?: (options: object) => void }).scrollIntoView?.({
      block: 'center',
      behavior: animated ? 'smooth' : 'auto',
    });
    return;
  }
  const inner = scroll.getInnerViewRef();
  if (inner === null) return;
  row.measureLayout(
    inner,
    (_x, y) => scroll.scrollTo({ y: Math.max(0, y - 120), animated }),
    () => undefined,
  );
}

/**
 * Jumping from a reply's quote to the original (T3 kit): the list scrolls to it and it flashes the
 * highlight for 1.2 s; under reduced motion it does not slide or flash, and a 2 px outline stays for
 * 3 s instead. An original older than what is on screen is looked for in older pages first. Each
 * message row registers its view, keyed by sequence.
 */
export function useMessageJump(scrollRef: RefObject<ScrollViewInstance | null>, reducedMotion: boolean) {
  const rows = useRef(new Map<number, HostInstance>());
  const [lit, setLit] = useState<number | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /** The ref callback of one message row. */
  const register = useCallback(
    (sequence: number) => (row: HostInstance | null) => {
      if (row === null) rows.current.delete(sequence);
      else rows.current.set(sequence, row);
    },
    [],
  );

  const light = useCallback(
    (sequence: number) => {
      clearTimeout(timer.current);
      setLit(sequence);
      timer.current = setTimeout(() => setLit(undefined), reducedMotion ? FLASH_OUTLINE_MS : FLASH_MS);
    },
    [reducedMotion],
  );

  const jump = useCallback(
    async (sequence: number, history?: OlderHistory): Promise<boolean> => {
      let pages = 0;
      while (!rows.current.has(sequence) && history?.hasOlder() === true && pages < MAX_OLDER_PAGES) {
        pages += 1;
        await history.loadOlder();
        // The rows of the new page mount on the next frames.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const row = rows.current.get(sequence);
      if (row === undefined) return false;
      scrollToRow(scrollRef.current, row, !reducedMotion);
      light(sequence);
      return true;
    },
    [light, reducedMotion, scrollRef],
  );

  return { register, jump, lit, flash: reducedMotion ? ('outline' as const) : ('fill' as const) };
}
