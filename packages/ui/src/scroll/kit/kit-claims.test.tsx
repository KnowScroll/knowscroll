import { render } from '@testing-library/react-native';
import { kitDefinition, kitKeys, type StageKitId, type WordState } from '@knowscroll/scroll-model';
import { KIT_PICTURES } from './registry';

/**
 * The words a kit's picture draws and the words of its text version must agree (D-204): the text version
 * says "false colour", "not to scale" or "stretched" only where the picture says so too, and the picture says
 * nothing a text version leaves out. Each claim is a pair, a pattern of the text version and a label of the
 * picture, and the two must be present together in every state, never one without the other.
 */
type Node = { readonly props?: { readonly content?: unknown }; readonly children?: readonly unknown[] | null };

function labelsOf(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree];
  if (typeof tree !== 'object' || tree === null) return [];
  const { props, children } = tree as Node;
  const own = typeof props?.content === 'string' ? [props.content] : [];
  return [...own, ...(children ?? []).flatMap(labelsOf)];
}

/** Every state a writer could choose for a kit whose focus is none, once each after settling. */
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

const CLAIMS: Readonly<Record<'starlight.v1' | 'black-hole.v1', readonly (readonly [RegExp, RegExp])[]>> = {
  'starlight.v1': [
    [/Colours are strengthened/u, /COLOURS STRENGTHENED/u],
    [/on a stretched scale|both on stretched scales/u, /STRETCHED/u],
    [/along a scale of distance from the star/u, /DISTANCE FROM THE STAR/u],
    [/inside the zone for/u, /IN THE ZONE/u],
    [/too hot for/u, /TOO HOT/u],
    [/too cold for/u, /TOO COLD/u],
    [/main sequence/u, /MAIN SEQUENCE/u],
    [/white dwarfs below/u, /WHITE DWARFS/u],
    [/Three bars compare/u, /TOTAL OUTPUT/u],
  ],
  'black-hole.v1': [
    [/false colour/u, /FALSE COLOUR/u],
    [/not to scale/iu, /NOT TO SCALE/u],
    [/so it is not the horizon itself/u, /NOT THE HORIZON ITSELF/u],
    [/graph of wave strength/u, /WAVE STRENGTH/u],
    [/drawn as circles for simplicity/u, /ORBITS DRAWN AS CIRCLES/u],
    [/Nothing shines|where nothing shines/u, /NOTHING SHINES/u],
    [/can be a black hole/u, /A BLACK HOLE CAN FORM/u],
    [/white dwarf/u, /WHITE DWARF/u],
    [/Light aimed straight outward from outside the horizon can get away/u, /LIGHT ESCAPES/u],
  ],
};

describe.each(['starlight.v1', 'black-hole.v1'] as const)(
  'the words of the text version and the picture of %s',
  (kit) => {
    it('say the same things in every state: a claim in one is a claim in the other', async () => {
      const picture = KIT_PICTURES[kit];
      const definition = kitDefinition(kit);
      const disagreements: string[] = [];
      for (const state of settledStates(kit)) {
        const view = await render(<picture.Picture scene={picture.sceneOf(state)} />);
        const labels = labelsOf(view.toJSON()).join(' | ');
        await view.unmount();
        const text = definition.describe(state);
        for (const [inText, inPicture] of CLAIMS[kit])
          if (inText.test(text) !== inPicture.test(labels))
            disagreements.push(`${JSON.stringify(state)}: ${String(inText)} / ${String(inPicture)}`);
      }
      expect(disagreements).toEqual([]);
    }, 30_000);

    it('never draws a word for what is not known or not drawn: no centre, no singularity, no habitable planet', async () => {
      const picture = KIT_PICTURES[kit];
      for (const state of settledStates(kit)) {
        const view = await render(<picture.Picture scene={picture.sceneOf(state)} />);
        const labels = labelsOf(view.toJSON()).join(' | ');
        await view.unmount();
        expect(labels).not.toMatch(/SINGULARITY|WORMHOLE|HABITABLE PLANET|INHABITED|LIFE|SUCK/u);
      }
    }, 30_000);
  },
);
