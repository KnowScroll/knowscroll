import type { Places } from './places';

/** The nearest ancestor that scrolls vertically: the essay's scroller. */
function scrollerOf(element: Element): Element | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/**
 * Web: a layout event reports a change of size but not a move, so a beat below a figure that grew would keep a stale
 * top. Each element is measured against its scroller when asked; a dozen or two `getBoundingClientRect` calls on a
 * scroll event are cheap.
 */
export function createPlaces(): Places {
  const elements = new Map<string, Element>();
  return {
    laidOut: () => undefined,
    attached: (id, element) => {
      if (element instanceof Element) elements.set(id, element);
      else elements.delete(id);
    },
    topOf: (id) => {
      const element = elements.get(id);
      const scroller = element === undefined ? null : scrollerOf(element);
      if (element === undefined || scroller === null || !element.isConnected) return undefined;
      return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    },
  };
}
