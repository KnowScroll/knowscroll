import { render } from '@testing-library/react-native';
import { kitDefinition, kitKeys, type StageKitId, type WordState } from '@knowscroll/scroll-model';
import { KIT_PICTURES } from './registry';

/**
 * Where the picture's words sit (D-204). The picture is a 320 × 200 frame. On a phone the stage's TEXT pill
 * covers its lower right corner, so no label may reach it; no label may run past the frame; and in the output
 * view no bar may cross a label. A label's box is estimated from its text (the mono face at 8.5 px is about 5.4
 * px a character), which is why the checks keep a margin.
 */
type Node = {
  readonly type?: string;
  readonly props?: Record<string, unknown>;
  readonly children?: readonly unknown[] | null;
};

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly text: string;
}

const CHARACTER_PX = 5.4;
const FRAME_WIDTH = 320;
/** The phone's TEXT pill, in frame units: from this x and this y to the corner. */
const PILL = { left: 272, top: 186 } as const;

function nodesOf(tree: unknown): Node[] {
  if (typeof tree !== 'object' || tree === null) return [];
  const node = tree as Node;
  return [node, ...(node.children ?? []).flatMap(nodesOf)];
}

function textOf(node: Node): string {
  return (node.children ?? [])
    .map((child) => (child as Node).props?.['content'])
    .filter((content): content is string => typeof content === 'string')
    .join('');
}

function labelBoxes(tree: unknown): Box[] {
  return nodesOf(tree)
    .filter((node) => node.type === 'RNSVGText')
    .map((node) => {
      const text = textOf(node);
      const font = node.props?.['font'] as { readonly textAnchor?: string } | undefined;
      const x = Number((node.props?.['x'] as readonly number[])[0]);
      const y = Number((node.props?.['y'] as readonly number[])[0]);
      const width = text.length * CHARACTER_PX;
      const left = font?.textAnchor === 'end' ? x - width : font?.textAnchor === 'start' ? x : x - width / 2;
      return { left, right: left + width, top: y - 8, bottom: y + 1.5, text };
    });
}

function barBoxes(tree: unknown): Box[] {
  return nodesOf(tree)
    .filter((node) => node.type === 'RNSVGRect' && node.props?.['fill'] !== null && node.props?.['fill'] !== undefined)
    .map((node) => {
      const { x, y, width, height } = node.props as Record<string, number>;
      return {
        left: Number(x),
        right: Number(x) + Number(width),
        top: Number(y),
        bottom: Number(y) + Number(height),
        text: 'bar',
      };
    });
}

const overlaps = (first: Box, second: Box): boolean =>
  first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;

function settledStates(kit: StageKitId): WordState[] {
  const definition = kitDefinition(kit);
  const all = kitKeys(definition)
    .filter((key) => key !== 'focus')
    .reduce<WordState[]>(
      (states, key) =>
        states.flatMap((state) => (definition.enums[key] ?? []).map((word) => ({ ...state, [key]: word }))),
      [{ focus: 'none' }],
    );
  const seen = new Set<string>();
  return all
    .map(definition.settle)
    .filter((state) => !seen.has(JSON.stringify(state)) && seen.add(JSON.stringify(state)));
}

describe.each(['starlight.v1', 'black-hole.v1'] as const)('the labels of the picture of %s', (kit) => {
  it('stay inside the frame and clear of the phone’s TEXT pill, in every state', async () => {
    const picture = KIT_PICTURES[kit];
    const problems: string[] = [];
    for (const state of settledStates(kit)) {
      const view = await render(<picture.Picture scene={picture.sceneOf(state)} />);
      const tree = view.toJSON();
      await view.unmount();
      for (const label of labelBoxes(tree)) {
        if (label.left < 0 || label.right > FRAME_WIDTH)
          problems.push(`${JSON.stringify(state)}: "${label.text}" leaves the frame`);
        if (label.right > PILL.left && label.bottom > PILL.top)
          problems.push(`${JSON.stringify(state)}: "${label.text}" reaches the TEXT pill`);
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  }, 60_000);
});

describe('the bars of the output view of starlight.v1', () => {
  it('never cross a label, for any star', async () => {
    const picture = KIT_PICTURES['starlight.v1'];
    const problems: string[] = [];
    for (const star of kitDefinition('starlight.v1').enums['star'] ?? []) {
      const state = kitDefinition('starlight.v1').settle({
        view: 'output',
        star,
        distance: 'near',
        orbit: 'none',
        focus: 'none',
      });
      const view = await render(<picture.Picture scene={picture.sceneOf(state)} />);
      const tree = view.toJSON();
      await view.unmount();
      const bars = barBoxes(tree);
      expect(bars.length).toBeGreaterThanOrEqual(3);
      for (const label of labelBoxes(tree))
        for (const bar of bars) if (overlaps(label, bar)) problems.push(`${star}: "${label.text}" is crossed by a bar`);
    }
    expect(problems).toEqual([]);
  }, 30_000);
});
