import { fontFamily, status } from '@knowscroll/design-tokens';

/**
 * The Operator screen's own neutral register (Operator.html): flat greys, mono type, no accent
 * colour. It shares no look with the consumer app on purpose, so nobody takes it for a product
 * screen. The one colour is the danger edge, for what needs a person (a gap, a failure), and it
 * always comes with words.
 */
export const operatorColor = {
  ground: '#F2F2F2',
  card: '#FFFFFF',
  cardEdge: '#BDBDBD',
  box: '#FAFAFA',
  boxEdge: '#CFCFCF',
  ink: '#111111',
  strong: '#333333',
  quiet: '#555555',
  faint: '#757575',
  chipEdge: '#9E9E9E',
  attention: status.danger.edge,
  attentionInk: status.danger.foreground,
} as const;

/** Narrow screens get one column; tablets two; desktops three, as the artboard draws. */
export function columnsFor(width: number): 1 | 2 | 3 {
  if (width >= 1024) return 3;
  if (width >= 600) return 2;
  return 1;
}

export const operatorFont = {
  mono: fontFamily.mono,
  text: fontFamily.text,
} as const;
