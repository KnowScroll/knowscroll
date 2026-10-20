import { z } from 'zod';
import { UniverseIdSchema, UuidSchema } from './ids.js';

const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Label = z
  .string()
  .min(1)
  .max(160)
  .refine((label) => label.trim().length > 0, 'A label cannot be blank.');
const TruthStatus = z.enum(['factual', 'hypothetical']);
const Activity = z.discriminatedUnion('availability', [
  z.strictObject({ availability: z.literal('available'), state: z.enum(['active', 'quiet']) }),
  z.strictObject({ availability: z.literal('unavailable') }),
]);

/** Transport bounds, not formation thresholds, quotas or claims about the person's exploration. */
export const GEOGRAPHY_LIMITS = {
  objects: 100,
  routes: 100,
  aliases: 100,
  operations: 32,
  deltas: 10,
} as const;

/** Geography identity is independent of any scene, generator, layout, seed or detail level. */
export const GeographyRevisionsSchema = z
  .strictObject({ revision: Counter, structureRevision: Counter, activityRevision: Counter })
  .refine((r) => r.structureRevision <= r.revision && r.activityRevision <= r.revision, 'Invalid geography revisions.');

const ObjectFields = {
  id: UuidSchema,
  objectRevision: Revision,
  label: Label,
  truthStatus: TruthStatus,
  activity: Activity,
  /** Immutable server transition that first established this object, preserved on every later read. */
  originTransitionId: UuidSchema,
};
const System = z.strictObject({
  ...ObjectFields,
  kind: z.literal('system'),
  parent: z.strictObject({ kind: z.literal('universe'), id: UniverseIdSchema }),
});
const Star = z.strictObject({
  ...ObjectFields,
  kind: z.literal('star'),
  parent: z.strictObject({ kind: z.literal('system'), id: UuidSchema }),
});
const Planet = z.strictObject({
  ...ObjectFields,
  kind: z.literal('planet'),
  parent: z.strictObject({ kind: z.literal('system'), id: UuidSchema }),
});
const Region = z.strictObject({
  ...ObjectFields,
  kind: z.literal('region'),
  parent: z.strictObject({ kind: z.literal('planet'), id: UuidSchema }),
});

/** Established places only. Dust/decoration, eligibility and promised future planets are not objects. */
export const GeographyObjectSchema = z
  .discriminatedUnion('kind', [System, Star, Planet, Region])
  .refine((o) => o.id !== o.parent.id, 'An object cannot parent itself.');

const RelationFields = {
  id: UuidSchema,
  relationRevision: Revision,
  originTransitionId: UuidSchema,
  status: z.enum(['current', 'withdrawn']),
};
/** Withdrawal retains identity/endpoints; inactivity never withdraws a relationship. */
export const GeographyRouteSchema = z
  .strictObject({
    ...RelationFields,
    kind: z.literal('route'),
    fromObjectId: UuidSchema,
    toObjectId: UuidSchema,
    truthStatus: TruthStatus,
  })
  .refine((r) => r.fromObjectId !== r.toObjectId, 'A route must connect different objects.');

/** Retained old identity after an authorised semantic correction; never a renderer's guessed merge. */
export const GeographyAliasSchema = z
  .strictObject({
    ...RelationFields,
    kind: z.literal('alias'),
    fromObjectId: UuidSchema,
    toObjectId: UuidSchema,
  })
  .refine((r) => r.fromObjectId !== r.toObjectId, 'An alias must resolve to a different identity.');

const Selection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('universe') }),
  z.strictObject({ kind: z.literal('system'), systemId: UuidSchema }),
]);
const Cursor = z.strictObject({
  universeId: UniverseIdSchema,
  privacyEpoch: Revision,
  geographyRevision: Counter,
  selection: Selection,
  afterObjectId: UuidSchema,
});

/**
 * Read only. The adapter derives the account, rechecks current authority and epoch, and validates
 * every cursor against that scope and immutable geography revision. A cursor grants no access.
 * Page in stable object-ID order; a changed revision requires a fresh read, never mixed pages.
 */
export const ReadGeographySchema = z
  .strictObject({
    selection: Selection,
    limit: z.number().int().min(1).max(GEOGRAPHY_LIMITS.objects),
    cursor: Cursor.optional(),
  })
  .refine(
    (q) => !q.cursor || sameSelection(q.selection, q.cursor.selection),
    'A cursor must retain its original selection.',
  );

const Page = z.strictObject({
  objects: z.array(GeographyObjectSchema).min(1).max(GEOGRAPHY_LIMITS.objects),
  routes: z.array(GeographyRouteSchema).max(GEOGRAPHY_LIMITS.routes),
  aliases: z.array(GeographyAliasSchema).max(GEOGRAPHY_LIMITS.aliases),
  continuation: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('complete') }),
    z.strictObject({ status: z.literal('more'), cursor: Cursor }),
  ]),
});

const ScopeFields = {
  universeId: UniverseIdSchema,
  privacyEpoch: Revision,
  /** Current locked personal-root watermark; neither a geography nor a Personal Context revision. */
  personalWatermark: Counter,
};
const SnapshotFields = {
  version: z.literal('geography-snapshot.v1'),
  ...ScopeFields,
  recordedAt: z.iso.datetime(),
  geography: GeographyRevisionsSchema,
  selection: Selection,
};

/**
 * Current authorised own-universe read, never a model proposal or permission to form anything.
 * Fence all responses by AccountScope/universe/epoch, then personalWatermark and geography.revision.
 * Preserve the last valid scene during lag; a newer personal watermark cannot excuse older geography.
 * Empty means no established places in this selection, not no encounters or no personal meaning.
 * Loading requires real initial projection work; unavailable/limit cannot masquerade as empty.
 * Routes/aliases can reference IDs on other pages. The backend validates hierarchy, scope, current
 * validity, alias resolution and factual/hypothetical separation; syntax never proves those facts.
 */
export const GeographySnapshotSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ ...SnapshotFields, status: z.literal('empty') }),
    z.strictObject({ ...SnapshotFields, status: z.literal('loading') }),
    z.strictObject({ ...SnapshotFields, status: z.literal('ready'), page: Page }),
    z.strictObject({ ...SnapshotFields, status: z.literal('lagging'), page: Page, pendingPersonalWatermark: Counter }),
    z.strictObject({
      ...SnapshotFields,
      status: z.literal('unavailable'),
      reason: z.enum(['temporarily_unavailable', 'snapshot_expired', 'limit']),
    }),
  ])
  .superRefine((s, ctx) => {
    if (s.status === 'lagging' && s.pendingPersonalWatermark > s.personalWatermark)
      ctx.addIssue({ code: 'custom', message: 'Pending watermark exceeds current personal scope.' });
    if (!('page' in s)) return;
    const { objects, routes, aliases, continuation } = s.page;
    const entries = [...objects, ...routes, ...aliases];
    if (new Set(entries.map((e) => e.id)).size !== entries.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate geography identity in page.' });
    for (const o of objects) {
      if (o.objectRevision > s.geography.revision || (o.kind === 'system' && o.parent.id !== s.universeId))
        ctx.addIssue({ code: 'custom', message: 'Object revision or universe is inconsistent.' });
    }
    for (const r of [...routes, ...aliases])
      if (r.relationRevision > s.geography.revision)
        ctx.addIssue({ code: 'custom', message: 'Relation revision exceeds geography revision.' });
    if (continuation.status === 'more') {
      const c = continuation.cursor;
      if (
        c.universeId !== s.universeId ||
        c.privacyEpoch !== s.privacyEpoch ||
        c.geographyRevision !== s.geography.revision ||
        !sameSelection(c.selection, s.selection) ||
        c.afterObjectId !== objects.at(-1)?.id
      )
        ctx.addIssue({ code: 'custom', message: 'Continuation does not belong to this snapshot page.' });
    }
  });

/** Applied public effects, not model output. Proposals, support/evidence refs and validation receipts stay backend-only. */
const Operation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create_system'), object: System }),
  z.strictObject({ kind: z.literal('establish_star'), object: Star }),
  z.strictObject({ kind: z.literal('form_planet'), object: Planet }),
  z.strictObject({ kind: z.literal('add_region'), object: Region }),
  z.strictObject({
    kind: z.literal('connect_route'),
    route: GeographyRouteSchema.refine((r) => r.status === 'current'),
  }),
  z.strictObject({ kind: z.literal('revise_label'), objectId: UuidSchema, objectRevision: Revision, label: Label }),
  z.strictObject({
    kind: z.literal('set_activity'),
    objectId: UuidSchema,
    objectRevision: Revision,
    activity: Activity,
  }),
  z.strictObject({ kind: z.literal('withdraw_relation'), relationId: UuidSchema, relationRevision: Revision }),
]);

/**
 * One atomic, already-validated commit. All operations apply together against exactly `base` or
 * require a fresh snapshot; a client never applies a convenient subset. Transition identity is
 * immutable across retries, catch-up and scene rebuilds. Remember it per account/epoch to support
 * once-per-transition presentation; changing a label/activity or re-rendering never forms a place.
 * This declaration does not implement cross-device shown/skipped acknowledgement.
 */
export const UniverseDeltaSchema = z
  .strictObject({
    version: z.literal('universe-delta.v1'),
    ...ScopeFields,
    transitionId: UuidSchema,
    recordedAt: z.iso.datetime(),
    base: GeographyRevisionsSchema,
    geography: GeographyRevisionsSchema,
    operations: z.array(Operation).min(1).max(GEOGRAPHY_LIMITS.operations),
  })
  .superRefine((d, ctx) => {
    const changesStructure = d.operations.some((op) => op.kind !== 'set_activity');
    const changesActivity = d.operations.some((op) => op.kind === 'set_activity');
    if (
      d.geography.revision !== d.base.revision + 1 ||
      d.geography.structureRevision !== (changesStructure ? d.geography.revision : d.base.structureRevision) ||
      d.geography.activityRevision !== (changesActivity ? d.geography.revision : d.base.activityRevision)
    )
      ctx.addIssue({ code: 'custom', message: 'Delta must advance geography and only changed component stamps.' });
    for (const op of d.operations) {
      const revision =
        'object' in op
          ? op.object.objectRevision
          : 'route' in op
            ? op.route.relationRevision
            : 'objectRevision' in op
              ? op.objectRevision
              : op.relationRevision;
      if (revision !== d.geography.revision)
        ctx.addIssue({ code: 'custom', message: 'Applied effect must carry its committed geography revision.' });
      if (
        'object' in op &&
        (op.object.originTransitionId !== d.transitionId ||
          op.object.id === op.object.parent.id ||
          (op.object.kind === 'system' && op.object.parent.id !== d.universeId))
      )
        ctx.addIssue({ code: 'custom', message: 'Creation must retain its real origin transition and parent.' });
      if ('route' in op && op.route.originTransitionId !== d.transitionId)
        ctx.addIssue({ code: 'custom', message: 'Route must retain its real origin transition.' });
    }
  });

/** A scoped revision cursor, not a command or a subscription; reads never enqueue formation. */
export const ReadUniverseDeltasSchema = z.strictObject({
  afterGeographyRevision: Counter,
  limit: z.number().int().min(1).max(GEOGRAPHY_LIMITS.deltas),
});

export const UniverseDeltasSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      version: z.literal('universe-deltas.v1'),
      ...ScopeFields,
      status: z.literal('available'),
      afterGeographyRevision: Counter,
      geography: GeographyRevisionsSchema,
      deltas: z.array(UniverseDeltaSchema).max(GEOGRAPHY_LIMITS.deltas),
      hasMore: z.boolean(),
    }),
    z.strictObject({
      version: z.literal('universe-deltas.v1'),
      ...ScopeFields,
      status: z.literal('snapshot_required'),
      geography: GeographyRevisionsSchema,
    }),
  ])
  .superRefine((s, ctx) => {
    if (s.status !== 'available') return;
    let previous = s.afterGeographyRevision;
    let previousComponents: z.infer<typeof GeographyRevisionsSchema> | undefined;
    let previousWatermark = 0;
    const ids = new Set<string>();
    for (const d of s.deltas) {
      if (
        d.universeId !== s.universeId ||
        d.privacyEpoch !== s.privacyEpoch ||
        d.personalWatermark > s.personalWatermark ||
        d.personalWatermark < previousWatermark ||
        d.base.revision !== previous ||
        ids.has(d.transitionId) ||
        (previousComponents &&
          (d.base.structureRevision !== previousComponents.structureRevision ||
            d.base.activityRevision !== previousComponents.activityRevision))
      )
        ctx.addIssue({ code: 'custom', message: 'Delta catch-up must be contiguous, unique and scope-fenced.' });
      ids.add(d.transitionId);
      previous = d.geography.revision;
      previousComponents = d.geography;
      previousWatermark = d.personalWatermark;
    }
    if (
      previous > s.geography.revision ||
      s.hasMore !== previous < s.geography.revision ||
      (s.hasMore && s.deltas.length === 0) ||
      (previousComponents &&
        (previousComponents.structureRevision > s.geography.structureRevision ||
          previousComponents.activityRevision > s.geography.activityRevision ||
          (!s.hasMore &&
            (previousComponents.structureRevision !== s.geography.structureRevision ||
              previousComponents.activityRevision !== s.geography.activityRevision))))
    )
      ctx.addIssue({ code: 'custom', message: 'Catch-up progress is inconsistent with current geography.' });
  });

function sameSelection(a: z.infer<typeof Selection>, b: z.infer<typeof Selection>): boolean {
  return a.kind === b.kind && (a.kind === 'universe' || (b.kind === 'system' && a.systemId === b.systemId));
}

export type GeographyRevisions = z.infer<typeof GeographyRevisionsSchema>;
export type GeographyObject = z.infer<typeof GeographyObjectSchema>;
export type GeographyRoute = z.infer<typeof GeographyRouteSchema>;
export type GeographyAlias = z.infer<typeof GeographyAliasSchema>;
export type ReadGeography = z.infer<typeof ReadGeographySchema>;
export type GeographySnapshot = z.infer<typeof GeographySnapshotSchema>;
export type UniverseDelta = z.infer<typeof UniverseDeltaSchema>;
export type ReadUniverseDeltas = z.infer<typeof ReadUniverseDeltasSchema>;
export type UniverseDeltas = z.infer<typeof UniverseDeltasSchema>;
