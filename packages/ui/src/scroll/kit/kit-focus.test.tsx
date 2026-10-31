import { render } from '@testing-library/react-native';
import Svg from 'react-native-svg';
import {
  kitDefinition,
  kitKeys,
  STAGE_KIT_IDS,
  TIDES_ENUMS,
  type StageKitId,
  type WordState,
} from '@knowscroll/scroll-model';
import { onCircle } from './earth-sky-scene';
import { FocusRing } from './parts';
import { KIT_PICTURES } from './registry';
import { bulgeTips, tidesSceneOf } from './tides-scene';

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
  });
});

/** The centre of each drawn focus ring of a picture. */
async function ringCentres(kit: StageKitId, state: WordState): Promise<{ x: number; y: number }[]> {
  const look = await ringLook();
  const picture = KIT_PICTURES[kit];
  const view = await render(<picture.Picture scene={picture.sceneOf(state)} />);
  const centres = nodesOf(view.toJSON())
    .filter(
      (node) =>
        JSON.stringify(node.props?.['stroke']) === JSON.stringify(look.stroke) &&
        JSON.stringify(node.props?.['strokeDasharray']) === JSON.stringify(look.dashes) &&
        node.props?.['cx'] !== undefined,
    )
    .map((node) => ({ x: Number(node.props?.['cx']), y: Number(node.props?.['cy']) }));
  await view.unmount();
  return centres;
}

describe('the bulge rings of the drawn tides picture', () => {
  it.each(TIDES_ENUMS.moonAt)(
    'at %s: the ring for the near bulge is drawn on the Moon’s side of Earth, the far one opposite',
    async (moonAt) => {
      const earth = { x: 178, y: 98 };
      const settle = (focus: string) => kitDefinition('tides.v1').settle({ view: 'sun-moon', moonAt, focus });
      const scene = tidesSceneOf(settle('none') as never);
      const moon = onCircle(earth, 70, scene.moonDegrees);
      const toward = (point: { x: number; y: number }) =>
        (point.x - earth.x) * (moon.x - earth.x) + (point.y - earth.y) * (moon.y - earth.y);
      const [near] = await ringCentres('tides.v1', settle('near-bulge'));
      const [far] = await ringCentres('tides.v1', settle('far-bulge'));
      expect(near).toBeDefined();
      expect(far).toBeDefined();
      expect(toward(near ?? earth)).toBeGreaterThan(0);
      expect(toward(far ?? earth)).toBeLessThan(0);
    },
  );
});

describe('the bulge rings of the tides picture', () => {
  const centre = { x: 178, y: 98 };

  it.each(TIDES_ENUMS.moonAt)('at %s: the near ring is on the Moon’s side and the far ring on the other', (moonAt) => {
    const state = kitDefinition('tides.v1').settle({ view: 'sun-moon', moonAt, focus: 'near-bulge' });
    const scene = tidesSceneOf(state as never);
    const moon = onCircle(centre, 70, scene.moonDegrees);
    const { near, far } = bulgeTips(scene, centre, 40);
    const toward = (point: { x: number; y: number }) =>
      (point.x - centre.x) * (moon.x - centre.x) + (point.y - centre.y) * (moon.y - centre.y);
    expect(toward(near)).toBeGreaterThan(0);
    expect(toward(far)).toBeLessThan(0);
    expect(Math.hypot(near.x - moon.x, near.y - moon.y)).toBeLessThan(Math.hypot(far.x - moon.x, far.y - moon.y));
  });
});
