import { BuildDataExportJobSchema } from '../events.js';
import type {
  ConsumeDataExportLink,
  DataExportSummary,
  ListDataExports,
  MintDataExportLink,
  PersonalAuthority,
  PersonalScopeTx,
  RequestDataExport,
  WithPersonalScope,
} from '../public.js';
import type { IdentitySecrets } from './ports.js';

/** The largest export file. Sections are bounded, so this is a guard, not a budget. */
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

/** A ready export is available this long; the file also goes at its first download. */
export const EXPORT_AVAILABLE_DAYS = 7;

/** A download link works once and for this long. */
export const EXPORT_LINK_SECONDS = 60;

/** Exports kept per account, newest first; asking for another removes the oldest. */
export const EXPORTS_KEPT = 5;

export type CreateOutcome =
  | { readonly kind: 'created' | 'replayed' | 'in_flight'; readonly export: DataExportSummary }
  | { readonly kind: 'id_in_use' };

export type MintOutcome =
  { readonly kind: 'minted'; readonly expiresAt: Date } | { readonly kind: 'not_found' | 'not_ready' };

/** Where an export build runs: the person's own universe, as the system. */
export interface BuildTarget {
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
}

export interface DataExportPorts {
  readonly withScope: WithPersonalScope;
  readonly secrets: IdentitySecrets;
  /** Inside the caller's scope; applies the policy above (idempotent id, one in flight, newest kept). */
  readonly create: (scope: PersonalScopeTx, accountId: string, exportId: string) => Promise<CreateOutcome>;
  readonly list: (scope: PersonalScopeTx, accountId: string) => Promise<readonly DataExportSummary[]>;
  /** Stores a link hash on a ready, unexpired export of this account. */
  readonly mintLink: (
    scope: PersonalScopeTx,
    accountId: string,
    exportId: string,
    linkHash: string,
  ) => Promise<MintOutcome>;
  /** Sends `identity.build-export` in the scope's transaction. */
  readonly enqueue: (scope: PersonalScopeTx, exportId: string) => Promise<void>;
  /** Hands over and removes the file behind a live link, once, if the account is still active. */
  readonly consume: (linkHash: string) => Promise<Uint8Array | undefined>;
  /** The universe a still-preparing export is built in; `undefined` when nothing is to be built. */
  readonly readBuildTarget: (exportId: string) => Promise<BuildTarget | undefined>;
  /** Locks the export row; whether it is still preparing. */
  readonly lockPreparing: (scope: PersonalScopeTx, exportId: string) => Promise<boolean>;
  /** Every module's section for this person (the registry's `exportPersonalData`). */
  readonly gather: (scope: PersonalScopeTx, person: { readonly accountId: string }) => Promise<unknown>;
  readonly storeReady: (scope: PersonalScopeTx, exportId: string, file: Uint8Array) => Promise<void>;
  readonly markFailedIn: (scope: PersonalScopeTx, exportId: string) => Promise<void>;
  /** After the final failed delivery. No effect on an export that is no longer preparing. */
  readonly markFailed: (exportId: string) => Promise<void>;
}

export type BuildOutcome = 'built' | 'skipped' | 'too_large';

/**
 * Personal data export (blueprint §19 "Export", D-043).
 *
 * `request` records the export and enqueues the build in one transaction under the person's
 * scope. `build` (worker) reads every module's own section inside the same locked scope, stores
 * the file on the export row and marks it ready; a refused scope builds nothing, and a stale epoch
 * is retried by the queue. The file is JSON of the person's own records only (see `ModuleExport`).
 * `mintLink` hands out a one-time token that is stored only as a hash; `consume` redeems it
 * without a session, once, within sixty seconds, and removes the file in the same transaction.
 */
export function makeDataExport(ports: DataExportPorts) {
  const accountOf = (authority: PersonalAuthority): string | undefined =>
    authority.actor.kind === 'account' ? authority.actor.accountId : undefined;

  const request: RequestDataExport = async (authority, { exportId }) => {
    const accountId = accountOf(authority);
    if (accountId === undefined) return { kind: 'refused', reason: 'scope_refused' };
    const outcome = await ports.withScope(authority, async (scope) => {
      const created = await ports.create(scope, accountId, exportId);
      if (created.kind === 'created') await ports.enqueue(scope, exportId);
      return created;
    });
    if (outcome.kind === 'refused') return { kind: 'refused', reason: 'scope_refused' };
    if (outcome.value.kind === 'id_in_use') return { kind: 'refused', reason: 'id_in_use' };
    return { kind: 'accepted', export: outcome.value.export };
  };

  const list: ListDataExports = async (authority) => {
    const accountId = accountOf(authority);
    if (accountId === undefined) return { kind: 'refused', reason: 'scope_refused' };
    const outcome = await ports.withScope(authority, (scope) => ports.list(scope, accountId));
    return outcome.kind === 'refused'
      ? { kind: 'refused', reason: 'scope_refused' }
      : { kind: 'ok', exports: outcome.value };
  };

  const mintLink: MintDataExportLink = async (authority, { exportId }) => {
    const accountId = accountOf(authority);
    if (accountId === undefined) return { kind: 'refused', reason: 'scope_refused' };
    const secret = ports.secrets.newDownloadSecret();
    const outcome = await ports.withScope(authority, (scope) =>
      ports.mintLink(scope, accountId, exportId, secret.hash),
    );
    if (outcome.kind === 'refused') return { kind: 'refused', reason: 'scope_refused' };
    if (outcome.value.kind !== 'minted') return { kind: 'refused', reason: outcome.value.kind };
    return { kind: 'link', token: secret.token, expiresAt: outcome.value.expiresAt };
  };

  const consume: ConsumeDataExportLink = async (token) => {
    const bytes = await ports.consume(ports.secrets.hashToken(token));
    return bytes === undefined ? { kind: 'gone' } : { kind: 'file', bytes };
  };

  async function build(input: unknown): Promise<BuildOutcome> {
    const { exportId } = BuildDataExportJobSchema.parse(input);
    const target = await ports.readBuildTarget(exportId);
    if (target === undefined) return 'skipped';
    const outcome = await ports.withScope(
      {
        universeId: target.universeId,
        privacyEpoch: target.privacyEpoch,
        actor: { kind: 'system', purpose: 'identity.build-export' },
      },
      async (scope): Promise<BuildOutcome> => {
        if (!(await ports.lockPreparing(scope, exportId))) return 'skipped';
        const file = new TextEncoder().encode(JSON.stringify(await ports.gather(scope, target)));
        if (file.byteLength > MAX_EXPORT_BYTES) {
          await ports.markFailedIn(scope, exportId);
          return 'too_large';
        }
        await ports.storeReady(scope, exportId, file);
        return 'built';
      },
    );
    if (outcome.kind === 'entered') return outcome.value;
    // A Clear or reset moved the epoch between reading and locking: the queue delivers again.
    if (outcome.refusal.kind === 'epoch_changed') throw new Error('EXPORT_EPOCH_CHANGED');
    // Suspended, deleting or gone: there is nothing to build for.
    return 'skipped';
  }

  async function fail(input: unknown): Promise<void> {
    await ports.markFailed(BuildDataExportJobSchema.parse(input).exportId);
  }

  return { request, list, mintLink, consume, build, fail };
}
