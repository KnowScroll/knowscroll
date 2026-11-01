import { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx, RecordingScopeTx } from '../../modules/identity/public.js';
import type { ProposeInput, ProposeOutcome } from './propose.js';
import { makeBoundPersonalHarness } from './propose.js';
import type {
  CheckPersonalRecordingRun,
  HarnessPorts,
  PersonalRecordingPurpose,
  PersonalRunAccounting,
  PersonalRunAccountingBinding,
  ReadPersonalRunAccountingBinding,
} from './ports.js';

const Counter = z.number().int().min(1).max(2_147_483_647);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * The closed set of owners, and what each may stamp on a run. The Planner and the Cartographer have one purpose each. Supply
 * names its steps itself: this engine does not name them, so a code is only checked to be one, and the schema
 * (`reasoning_personal_recording_proof_shape`, migration 0094) and Supply's owner check hold the list.
 */
const PURPOSE_CODE = /^[a-z][a-z0-9-]{0,63}$/u;
function purposeFitsOwner(p: { readonly ownerModule: string; readonly purpose: string }): boolean {
  switch (p.ownerModule) {
    case 'planner':
      return p.purpose === 'personal-planner';
    case 'geography':
      return p.purpose === 'personal-cartographer';
    default:
      return p.ownerModule === 'supply' && PURPOSE_CODE.test(p.purpose);
  }
}

const Purpose = z
  .strictObject({
    version: z.literal('personal-role-purpose.v1'),
    accountId: z.uuid(),
    universeId: z.uuid(),
    privacyEpoch: Counter,
    ownerModule: z.enum(['planner', 'geography', 'supply']),
    purpose: z.string().max(64),
    businessRunId: z.uuid(),
    recordingGeneration: Counter.refine((g) => g % 2 === 1),
    contextSha256: Digest,
    modelContextSha256: Digest,
    claimId: z.uuid(),
  })
  .refine(purposeFitsOwner);

/** Public data is inspected without invoking getters, including symbols/nonenumerable extras. */
function data(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    )
      return undefined;
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !keys.includes(key) || !d || !('value' in d) || !d.enumerable) return undefined;
      result[key] = d.value;
    }
    return result;
  } catch {
    return undefined;
  }
}
function authoritySnapshot(value: unknown): PersonalAuthority | undefined {
  const authority = data(value, ['universeId', 'privacyEpoch', 'actor']);
  const actor = data(authority?.actor, ['kind', 'purpose', 'accountId']);
  if (!authority || !actor) return undefined;
  const parsed = z
    .strictObject({
      universeId: z.uuid(),
      privacyEpoch: Counter,
      actor: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('account'), accountId: z.uuid() }),
        z.strictObject({ kind: z.literal('system'), purpose: z.string().min(1).max(160) }),
      ]),
    })
    .safeParse({ ...authority, actor });
  return parsed.success ? Object.freeze({ ...parsed.data, actor: Object.freeze(parsed.data.actor) }) : undefined;
}
const AccountingBinding = z
  .strictObject({
    ownerModule: z.enum(['planner', 'geography']),
    purpose: z.enum(['personal-planner', 'personal-cartographer']),
    accountId: z.uuid(),
    privacyEpoch: Counter,
    recordingGeneration: Counter.refine((g) => g % 2 === 1).nullable(),
  })
  .refine((p) =>
    p.ownerModule === 'planner' ? p.purpose === 'personal-planner' : p.purpose === 'personal-cartographer',
  );
export function parsePersonalRunAccountingBinding(value: unknown): PersonalRunAccountingBinding | undefined {
  const d = data(value, Object.keys(AccountingBinding.shape));
  if (!d) return undefined;
  const parsed = AccountingBinding.safeParse(d);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}
const purposeKeys = Object.keys(Purpose.shape);
export function parsePersonalRecordingPurpose(value: unknown): PersonalRecordingPurpose | undefined {
  const d = data(value, purposeKeys);
  if (!d) return undefined;
  const parsed = Purpose.safeParse(d);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}
export type {
  PersonalRecordingPurpose,
  CheckPersonalRecordingRun,
  PersonalRunAccounting,
  PersonalRunAccountingBinding,
  ReadPersonalRunAccountingBinding,
} from './ports.js';
export interface PersonalRecordingProposeInput<T> extends ProposeInput<T> {
  readonly recordingPurpose: PersonalRecordingPurpose;
}
export interface RecordingReasoningHarness {
  proposePersonal<T>(input: PersonalRecordingProposeInput<T>, signal: AbortSignal): Promise<ProposeOutcome<T>>;
  withPersonalApply<T>(
    authority: PersonalAuthority,
    purpose: PersonalRecordingPurpose,
    work: (scope: RecordingScopeTx) => Promise<T>,
  ): Promise<
    | { readonly kind: 'entered'; readonly value: T }
    | { readonly kind: 'refused'; readonly refusal: { readonly kind: string } }
  >;
  /** Same current-g transaction as personal apply; never an accounting cleanup shortcut. */
  closePersonalRun(
    scope: RecordingScopeTx,
    run: {
      readonly runId: string;
      readonly state: 'completed' | 'failed' | 'cancelled';
      readonly recordingPurpose: PersonalRecordingPurpose;
    },
  ): Promise<'closed' | 'not_open'>;
  /** Own current root/account/epoch, but no original-g gate and no private payloads. */
  readPersonalRunAccounting(
    scope: PersonalScopeTx,
    runId: string,
    readExpectedBinding: ReadPersonalRunAccountingBinding,
  ): Promise<PersonalRunAccounting>;
}
export interface PersonalRecordingHarnessPorts {
  readonly engine: HarnessPorts;
  readonly checkPlanner: CheckPersonalRecordingRun;
  readonly checkGeography: CheckPersonalRecordingRun;
  readonly checkSupply: CheckPersonalRecordingRun;
  readonly hashContext: (context: ProposeInput<unknown>['context']) => string;
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Required, closed three-owner dispatch. No string-selected registry or absent-success fallback. */
export function recordingOwnerDispatcher(
  ports: Pick<PersonalRecordingHarnessPorts, 'checkPlanner' | 'checkGeography' | 'checkSupply'>,
): CheckPersonalRecordingRun {
  if (
    typeof ports.checkPlanner !== 'function' ||
    typeof ports.checkGeography !== 'function' ||
    typeof ports.checkSupply !== 'function'
  )
    throw new Error('PERSONAL_RECORDING_OWNERS_REQUIRED');
  return (scope, value) => {
    const p = parsePersonalRecordingPurpose(value);
    if (!p) return Promise.resolve('unavailable');
    switch (p.ownerModule) {
      case 'planner':
        return ports.checkPlanner(scope, p);
      case 'geography':
        return ports.checkGeography(scope, p);
      case 'supply':
        return ports.checkSupply(scope, p);
    }
  };
}

/** Immutable private data snapshots cross network waits; capabilities never do. */
function snapshot<T>(input: PersonalRecordingProposeInput<T>): PersonalRecordingProposeInput<T> | undefined {
  const outer = data(input, ['run', 'role', 'context', 'limits', 'recordingPurpose']);
  const run = data(outer?.run, ['id', 'authority', 'ownerModule', 'purpose', 'policyVersion']);
  const context = data(outer?.context, ['bundleRef', 'items']);
  const role = data(outer?.role, [
    'id',
    'version',
    'instructions',
    'outputSchema',
    'maxOutputTokens',
    'effort',
    'minContextItems',
    'budget',
    'budgetClass',
    'safeCustomIssues',
  ]);
  const authority = data(run?.authority, ['universeId', 'privacyEpoch', 'actor']);
  const actor = data(authority?.actor, ['kind', 'purpose', 'accountId']);
  const purpose = parsePersonalRecordingPurpose(outer?.recordingPurpose);
  if (
    !outer ||
    !run ||
    !context ||
    !role ||
    !authority ||
    !actor ||
    !purpose ||
    typeof run.id !== 'string' ||
    !z.uuid().safeParse(run.id).success ||
    typeof run.ownerModule !== 'string' ||
    typeof run.purpose !== 'string' ||
    typeof run.policyVersion !== 'string' ||
    typeof role.id !== 'string' ||
    typeof role.version !== 'string' ||
    typeof role.instructions !== 'string' ||
    typeof role.maxOutputTokens !== 'number' ||
    !Number.isInteger(role.maxOutputTokens) ||
    !(role.outputSchema instanceof z.ZodType) ||
    (role.effort !== undefined && role.effort !== 'low' && role.effort !== 'medium' && role.effort !== 'high') ||
    (role.minContextItems !== undefined &&
      (typeof role.minContextItems !== 'number' || !Number.isInteger(role.minContextItems))) ||
    (role.budgetClass !== undefined && role.budgetClass !== 'background' && role.budgetClass !== 'interactive') ||
    typeof context.bundleRef !== 'string' ||
    context.bundleRef.length > 128 ||
    !Array.isArray(context.items) ||
    context.items.length > 64
  )
    return undefined;
  const items = [];
  for (let n = 0; n < context.items.length; n++) {
    const property = Object.getOwnPropertyDescriptor(context.items, String(n));
    if (!property || !('value' in property) || !property.enumerable) return undefined;
    const item = data(property.value, ['ref', 'kind', 'text']);
    if (
      !item ||
      typeof item.ref !== 'string' ||
      item.ref.length > 128 ||
      typeof item.kind !== 'string' ||
      item.kind.length > 32 ||
      typeof item.text !== 'string' ||
      item.text.length > 32768
    )
      return undefined;
    items.push(Object.freeze({ ref: item.ref, kind: item.kind, text: item.text }));
  }
  if (
    Reflect.ownKeys(context.items).some(
      (k) => k !== 'length' && (typeof k !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(k) || Number(k) >= items.length),
    )
  )
    return undefined;
  const actorParsed = z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('account'), accountId: z.uuid() }),
      z.strictObject({ kind: z.literal('system'), purpose: z.string().min(1).max(160) }),
    ])
    .safeParse(actor);
  if (
    !actorParsed.success ||
    !z.uuid().safeParse(authority.universeId).success ||
    !Counter.safeParse(authority.privacyEpoch).success
  )
    return undefined;
  const limits = outer.limits === undefined ? undefined : data(outer.limits, ['allowRepair']);
  if (
    outer.limits !== undefined &&
    (!limits || (limits.allowRepair !== undefined && typeof limits.allowRepair !== 'boolean'))
  )
    return undefined;
  if (role.budget !== undefined) {
    const budget = data(role.budget, ['requestsPerDay', 'tokensPerDay']);
    if (
      !budget ||
      Object.keys(budget).length !== 2 ||
      Object.values(budget).some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    )
      return undefined;
    role.budget = Object.freeze(budget);
  }
  return Object.freeze({
    ...outer,
    recordingPurpose: purpose,
    run: Object.freeze({ ...run, authority: Object.freeze({ ...authority, actor: Object.freeze(actor) }) }),
    role: Object.freeze(role),
    context: Object.freeze({ bundleRef: context.bundleRef, items: Object.freeze(items) }),
    ...(limits ? { limits: Object.freeze(limits) } : {}),
  }) as unknown as PersonalRecordingProposeInput<T>;
}
export function makePersonalRecordingReasoningHarness(ports: PersonalRecordingHarnessPorts): RecordingReasoningHarness {
  // Construction is refused even if no call has arrived; both actual owning adapters are mandatory.
  recordingOwnerDispatcher(ports);
  return {
    async proposePersonal<T>(input: PersonalRecordingProposeInput<T>, signal: AbortSignal): Promise<ProposeOutcome<T>> {
      const frozen = snapshot(input);
      if (!frozen) return { kind: 'refused', reason: 'run_invalid' };
      const p = frozen.recordingPurpose,
        r = frozen.run;
      if (
        typeof r.id !== 'string' ||
        typeof r.authority.universeId !== 'string' ||
        !sameId(p.businessRunId, r.id) ||
        !sameId(p.universeId, r.authority.universeId) ||
        p.privacyEpoch !== r.authority.privacyEpoch ||
        p.ownerModule !== r.ownerModule ||
        p.purpose !== r.purpose ||
        (r.authority.actor.kind === 'account' && !sameId(p.accountId, r.authority.actor.accountId))
      )
        return { kind: 'refused', reason: 'run_mismatch' };
      if (ports.hashContext(frozen.context) !== p.modelContextSha256)
        return { kind: 'refused', reason: 'run_mismatch' };
      return makeBoundPersonalHarness(ports.engine, p).propose(frozen, signal);
    },
    withPersonalApply(authority, value, work) {
      const purpose = parsePersonalRecordingPurpose(value);
      const frozenAuthority = authoritySnapshot(authority);
      if (!purpose || !frozenAuthority || typeof work !== 'function')
        return Promise.resolve({ kind: 'refused', refusal: { kind: 'scope_refused' } });
      return ports.engine.personalAccess.apply(frozenAuthority, purpose, work);
    },
    closePersonalRun(scope, value) {
      const body = data(value, ['runId', 'state', 'recordingPurpose']);
      const p = parsePersonalRecordingPurpose(body?.recordingPurpose);
      if (
        !body ||
        !p ||
        typeof body.runId !== 'string' ||
        !sameId(body.runId, p.businessRunId) ||
        typeof body.state !== 'string' ||
        !['completed', 'failed', 'cancelled'].includes(body.state)
      )
        throw new Error('PERSONAL_RECORDING_CLOSE_INVALID');
      return ports.engine.personalAccess.close(scope, p, {
        runId: body.runId,
        state: body.state as 'completed' | 'failed' | 'cancelled',
      });
    },
    readPersonalRunAccounting: (scope, runId, readExpectedBinding) =>
      ports.engine.personalAccess.readAccounting(scope, runId, readExpectedBinding),
  };
}
