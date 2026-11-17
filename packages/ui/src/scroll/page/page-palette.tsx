import { createContext, useContext } from 'react';
import { printed } from '@knowscroll/design-tokens';

/**
 * The colours of a Scroll's page, by job. Folio and the figures take them from here at render time rather than from
 * module constants, because native styles are fixed when a module loads: a palette in context is the only way a page
 * can change appearance on a phone without a reload.
 */
export interface PagePalette {
  /** The ground the essay is printed on. */
  readonly ground: string;
  /** A figure's plate and other raised surfaces. */
  readonly raised: string;
  readonly ink: string;
  /** Secondary text: kickers, captions, a held beat that is not the one the figure shows. */
  readonly ink2: string;
  /** Hairlines between parts of the page. */
  readonly rule: string;
  /** Text that is a link or a quiet action. */
  readonly link: string;
}

/** Today's printed page: the Light values of the content register, in both appearances (D-400). */
const PRINTED_PAGE: PagePalette = {
  ground: printed.paper,
  raised: printed.paper2,
  ink: printed.ink,
  ink2: printed.ink2,
  rule: printed.rule,
  link: printed.accentDeep,
};

/** A page's palette. Every page is printed Light for now (D-400); a provider will give the dark page its own. */
const PageContext = createContext<PagePalette>(PRINTED_PAGE);

export function usePagePalette(): PagePalette {
  return useContext(PageContext);
}
