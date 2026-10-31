import { z } from '../../zod.js';

/** The words a writer may choose for each key of a kit's stage state: a closed list per key. */
export type KitEnums = Readonly<Record<string, readonly [string, ...string[]]>>;

/** One complete state of a kit: every key has a word. A stored document holds only settled states. */
export type KitState<Enums extends KitEnums> = { readonly [Key in keyof Enums]: Enums[Key][number] };

/** What a stop changes: the keys it names. The rest carry over from the previous state. */
export type KitPatch<Enums extends KitEnums> = { readonly [Key in keyof Enums]?: Enums[Key][number] };

/** A kit's state seen by code that handles every kit alike (the document, the assembler, the writer rules). */
export type WordState = Readonly<Record<string, string>>;

/**
 * What the document, the assembler and the writer's rules need of a drawing kit (D-194), whatever it
 * draws. A kit is a closed set of words the writer may choose, a way to set aside the words its view
 * does not draw, a first state and the sentences that describe a state. Everything physical a kit
 * shows is derived by its own code from those words (D-195); nothing here lets a writer state a fact.
 */
export interface KitDefinition {
  readonly id: string;
  readonly enums: KitEnums;
  /** The state before any stop changes it. */
  readonly initial: WordState;
  /** The state a view can really show: what it does not draw is set aside. Idempotent. */
  readonly settle: (state: WordState) => WordState;
  /** The text version and the accessible name of a state, derived by code. */
  readonly describe: (state: WordState) => string;
  /** Lines for the writer's instructions: what the picture draws, what each key means, what code decides. */
  readonly writerGuide: readonly string[];
}

/** The keys of a kit, in the order its state lists them. */
export function kitKeys(kit: Pick<KitDefinition, 'enums'>): readonly string[] {
  return Object.keys(kit.enums);
}

/**
 * Types a kit's own functions as the generic definition. The kit's functions take its own state type
 * and the definition's take words; a stored or authored state reaches them only after it has passed
 * `kitStateSchema` or `isKitPatch`, which is why the one cast here is sound.
 */
export function defineKit<Enums extends KitEnums>(kit: {
  readonly id: string;
  readonly enums: Enums;
  readonly initial: KitState<Enums>;
  readonly settle: (state: KitState<Enums>) => KitState<Enums>;
  readonly describe: (state: KitState<Enums>) => string;
  readonly writerGuide: readonly string[];
}): KitDefinition {
  return kit as unknown as KitDefinition;
}

/** The schema of a kit's complete state: every key present, each a word from its list, nothing else. */
export function kitStateSchema<Enums extends KitEnums>(enums: Enums): z.ZodType<KitState<Enums>> {
  const shape = Object.fromEntries(Object.entries(enums).map(([key, words]) => [key, z.enum(words)]));
  return z.strictObject(shape) as unknown as z.ZodType<KitState<Enums>>;
}

/** Whether `patch` names only keys of the kit and only words allowed for them. Anything else is not a patch of this kit. */
export function isKitPatch(kit: Pick<KitDefinition, 'enums'>, patch: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(patch).every(([key, value]) => {
    const words = Object.hasOwn(kit.enums, key) ? kit.enums[key] : undefined;
    return words !== undefined && typeof value === 'string' && words.includes(value);
  });
}

/**
 * The state after a stop's changes: a patched key replaces the previous value, the rest carry over.
 * Total over model output: a key the kit does not have, or a word it does not list, changes nothing here
 * (the authoring rules refuse such a patch, `stage_choice_invalid`), so a settled state is always made of
 * the kit's own words.
 */
export function applyKitPatch(
  kit: Pick<KitDefinition, 'enums'>,
  previous: WordState,
  patch: Readonly<Record<string, string | undefined>> | undefined,
): WordState {
  if (patch === undefined) return previous;
  const next: Record<string, string> = { ...previous };
  for (const key of kitKeys(kit)) {
    const value = patch[key];
    if (value !== undefined && kit.enums[key]?.includes(value) === true) next[key] = value;
  }
  return next;
}
