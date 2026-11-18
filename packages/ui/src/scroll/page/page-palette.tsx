import { content, scrollPage } from '@knowscroll/design-tokens';

/**
 * The colours of a Scroll's page, by job. Folio and its figures read them here rather than naming tokens, so the page's
 * appearance is decided in one place: on the web they are the page's own custom properties, which follow the person's
 * appearance inside a page (`scrollPageSurface`, D-424); on native they are the printed Light values until native can
 * read the appearance (#740).
 */
export interface PagePalette {
  /** The ground the essay is printed on. */
  readonly ground: string;
  /** A figure's plate. */
  readonly raised: string;
  readonly ink: string;
  /** Secondary text: kickers, captions, a held beat that is not the one the figure shows. */
  readonly ink2: string;
  /** Hairlines between parts of the page. */
  readonly rule: string;
  /** Text that is a link or a quiet action. */
  readonly link: string;
}

const PAGE: PagePalette = {
  ground: content.paper,
  raised: scrollPage.plate,
  ink: content.ink,
  ink2: content.ink2,
  rule: content.rule,
  link: content.accentDeep,
};

export function usePagePalette(): PagePalette {
  return PAGE;
}
