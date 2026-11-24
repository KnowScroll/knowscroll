import { render } from '@testing-library/react-native';
import Svg from 'react-native-svg';
import { kitDefinition, kitKeys, STAGE_KIT_IDS, type StageKitId, type WordState } from '@knowscroll/scroll-model';
import { FocusRing } from './parts';
import { KIT_PICTURES } from './registry';

/**
 * Every state a writer could choose for a kit, once each after settling: the product of the words of all
 * its keys. The text version says "the picture draws the eye to ..." for each focus that survives settling,
 * so the picture must draw a ring for it.
 */
function settledStates(kit: StageKitId): WordState[] {
  const definition = kitDefinition(kit);
  const all = kitKeys(definition).reduce<WordState[]>(
    (states, key) =>
      states.flatMap((state) => (definition.enums[key] ?? []).map((word) => ({ ...state, [key]: word }))),
    [{}],
  );
  const seen = new Set<string>();
  return all
    .map(definition.settle)
    .filter((state) => !seen.has(JSON.stringify(state)) && seen.add(JSON.stringify(state)));
}

type Node = {
  readonly type?: string;
  readonly props?: Record<string, unknown>;
  readonly children?: readonly unknown[] | null;
};

function nodesOf(tree: unknown): Node[] {
  if (typeof tree !== 'object' || tree === null) return [];
  const node = tree as Node;
  return [node, ...(node.children ?? []).flatMap(nodesOf)];
}

/** How a focus ring looks once drawn: its stroke and its dashes, learned from the shared part itself. */
async function ringLook(): Promise<{ stroke: unknown; dashes: unknown }> {
  const view = await render(
    <Svg>
      <FocusRing at={{ x: 10, y: 10 }} radius={5} />
    </Svg>,
  );
  const ring = nodesOf(view.toJSON()).find((node) => node.props?.['strokeDasharray'] !== undefined);
  if (ring?.props === undefined) throw new Error('a focus ring draws a dashed stroke');
  const look = { stroke: ring.props['stroke'], dashes: ring.props['strokeDasharray'] };
  await view.unmount();
  return look;
}

describe.each(STAGE_KIT_IDS.filter((id) => id !== 'earth-sky.v1'))('the focus of the kit %s', (kit) => {
  it('is drawn as a ring for every state whose focus survives settling, and no ring is drawn for none', async () => {
    const look = await ringLook();
    const picture = KIT_PICTURES[kit];
    const missing: string[] = [];
    for (const state of settledStates(kit)) {
      const view = await render(<picture.Picture scene={picture.sceneOf(state)} />);
      const rings = nodesOf(view.toJSON()).filter(
        (node) =>
          JSON.stringify(node.props?.['stroke']) === JSON.stringify(look.stroke) &&
          JSON.stringify(node.props?.['strokeDasharray']) === JSON.stringify(look.dashes),
      ).length;
      await view.unmount();
      if ((state['focus'] === 'none') !== (rings === 0))
        missing.push(`${JSON.stringify(state)} has ${String(rings)} rings`);
    }
    expect(missing).toEqual([]);
  }, 30_000);
});
