import { z } from 'zod';
import { FIELD_LIMITS, LIMITS } from '../limits.js';
import { FiniteNumber, LocalId, ParamKey, plainText } from '../primitives.js';

/** How a number is shown: fixed decimals, optional thousands grouping, `~` prefix and suffix. */
export const NumberFormat = z.strictObject({
  decimals: z.number().int().min(0).max(4),
  grouping: z.boolean(),
  approximate: z.boolean(),
  suffix: plainText(1, 8).optional(),
});
export type NumberFormat = z.infer<typeof NumberFormat>;

/**
 * A reader-controlled number. Values live on the grid `min + k·step` within `[min, max]`.
 * `personal: true` marks the reader's own data (body weight, age, income): never in telemetry, and
 * in a snippet only when the sender explicitly includes it.
 */
export const SimulationParam = z.strictObject({
  key: ParamKey,
  label: plainText(1, 60),
  unit: plainText(1, 16).optional(),
  min: FiniteNumber,
  max: FiniteNumber,
  step: FiniteNumber,
  default: FiniteNumber,
  /** The primary control; every number also gets a stepper in text-version mode. */
  control: z.enum(['slider', 'stepper', 'input']),
  format: NumberFormat,
  personal: z.literal(true).optional(),
});
export type SimulationParam = z.infer<typeof SimulationParam>;

/** A named number used by formulas. Non-illustrative simulations bind every constant to a claim. */
export const SimulationConstant = z.strictObject({
  key: ParamKey,
  label: plainText(1, 60),
  value: FiniteNumber,
  unit: plainText(1, 16).optional(),
});
export type SimulationConstant = z.infer<typeof SimulationConstant>;

/** A literal number or a reference to a parameter, constant or earlier output by key. */
export const Operand = z.union([FiniteNumber, ParamKey]);
export type Operand = z.infer<typeof Operand>;

/**
 * The closed set of formula kinds (no expression grammar in v1). Every kind is evaluated by
 * `evaluateFormula` in bounded, constant time.
 */
export const Formula = z.discriminatedUnion('kind', [
  /** a·x + b */
  z.strictObject({ kind: z.literal('linear'), x: Operand, a: Operand, b: Operand }),
  /** f₁ · f₂ · … (2–4 factors) */
  z.strictObject({ kind: z.literal('product'), factors: z.array(Operand).min(2).max(4) }),
  /** numerator / denominator */
  z.strictObject({ kind: z.literal('ratio'), numerator: Operand, denominator: Operand }),
  /** scale · (x / base)^exponent; the exponent is structural (e.g. 2 for "squared"). */
  z.strictObject({
    kind: z.literal('power'),
    x: Operand,
    base: Operand,
    exponent: z.number().min(-4).max(4),
    scale: Operand,
  }),
  /** initial · e^(rate · x) */
  z.strictObject({ kind: z.literal('exponential'), x: Operand, rate: Operand, initial: Operand }),
  /** k / r² */
  z.strictObject({ kind: z.literal('inverse-square'), r: Operand, k: Operand }),
  /**
   * A table over a parameter: `step` takes the value of the last entry at or below the input,
   * `interpolate` is piecewise linear; both clamp outside the table. `at` strictly increases.
   */
  z.strictObject({
    kind: z.literal('lookup'),
    input: ParamKey,
    mode: z.enum(['step', 'interpolate']),
    table: z
      .array(z.strictObject({ at: FiniteNumber, value: Operand }))
      .min(2)
      .max(FIELD_LIMITS.lookupEntries),
  }),
]);
export type Formula = z.infer<typeof Formula>;
export const FORMULA_KINDS = [
  'linear',
  'product',
  'ratio',
  'power',
  'exponential',
  'inverse-square',
  'lookup',
] as const;

/** A computed value; outputs are evaluated in order and may use earlier outputs. */
export const SimulationOutput = z.strictObject({
  key: ParamKey,
  label: plainText(1, 60),
  unit: plainText(1, 16).optional(),
  formula: Formula,
  format: NumberFormat,
});
export type SimulationOutput = z.infer<typeof SimulationOutput>;

/**
 * The closed set of views.
 * - `readout`: one large output (and an optional secondary), plus the readout sentence.
 * - `cards`: 2–8 outputs side by side, each with a bar scaled to `barMax`.
 * - `plot`: an output as a curve over one parameter's range, with a marker at its value.
 * - `area`: a parameter as a bar beside an output as a square of proportional area.
 */
export const SimulationView = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('readout'), primary: ParamKey, secondary: ParamKey.optional() }),
  z.strictObject({
    kind: z.literal('cards'),
    items: z
      .array(
        z.strictObject({
          id: LocalId,
          label: plainText(1, 32),
          output: ParamKey,
          note: plainText(1, 120).optional(),
        }),
      )
      .min(2)
      .max(FIELD_LIMITS.cards),
    /** Display scale: the value that fills a bar. */
    barMax: FiniteNumber,
  }),
  z.strictObject({
    kind: z.literal('plot'),
    x: ParamKey,
    y: ParamKey,
    yLabel: plainText(1, 40),
    yDomain: z.tuple([FiniteNumber, FiniteNumber]),
  }),
  z.strictObject({
    kind: z.literal('area'),
    length: ParamKey,
    area: ParamKey,
    lengthLabel: plainText(1, 40),
    areaLabel: plainText(1, 40),
  }),
]);
export type SimulationView = z.infer<typeof SimulationView>;
export const SIMULATION_VIEWS = ['readout', 'cards', 'plot', 'area'] as const;

const TEMPLATE_SYNTAX = /^(?:[^{}]|\{[a-z][a-zA-Z0-9]{0,23}\})*$/u;

/** Literal text with `{key}` placeholders for parameters, constants and outputs. No logic. */
export const Template = plainText(1, FIELD_LIMITS.templateChars).refine((text) => TEMPLATE_SYNTAX.test(text), {
  message: 'template_syntax',
});

export function templateKeys(template: string): string[] {
  return [...template.matchAll(/\{([a-z][a-zA-Z0-9]{0,23})\}/gu)].map((match) => match[1] ?? '');
}

/** The sentence under the view, and band sentences chosen by an output's range (`min ≤ v < max`). */
export const SimulationReadout = z.strictObject({
  template: Template,
  bands: z
    .array(
      z.strictObject({
        output: ParamKey,
        min: FiniteNumber.optional(),
        max: FiniteNumber.optional(),
        text: plainText(1, 200),
      }),
    )
    .max(FIELD_LIMITS.readoutBands),
});
export type SimulationReadout = z.infer<typeof SimulationReadout>;

export const SimulationData = z.strictObject({
  title: plainText(1, 100),
  prompt: plainText(1, 120).optional(),
  params: z.array(SimulationParam).min(1).max(LIMITS.paramsPerBlock),
  constants: z.array(SimulationConstant).max(FIELD_LIMITS.constants),
  outputs: z.array(SimulationOutput).min(1).max(FIELD_LIMITS.outputs),
  view: SimulationView,
  readout: SimulationReadout.optional(),
  /** Units, assumptions and limits, shown under the view (e.g. "illustrative, not a forecast"). */
  modelNote: plainText(10, 240),
  /** true: the numbers are a teaching choice; false: every constant is bound to a claim. */
  illustrative: z.boolean(),
});
export type SimulationData = z.infer<typeof SimulationData>;
