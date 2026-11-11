import { defineLab } from './lab.js';
import { focusedDeepReader, linkReaderScrolls, sideBySideNeighbour, topicSwitcher } from './personas.js';

/**
 * The readers who go deep, so places form: a reader who follows links to three Scrolls of one planet (a planet must
 * form), an explicit topic switcher who opens a region of their map, and a focused deep reader beside a neighbour who
 * likes and saves (their rows must never change each other's).
 */
defineLab({
  group: 'formation',
  solo: [linkReaderScrolls, topicSwitcher],
  sideBySide: [focusedDeepReader, sideBySideNeighbour],
});
