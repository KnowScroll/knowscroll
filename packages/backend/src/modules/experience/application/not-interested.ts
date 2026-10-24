import {
  NotInterestedResponseSchema,
  UndoNotInterestedResponseSchema,
  type NotInterestedRequest,
  type NotInterestedResponse,
  type UndoNotInterestedRequest,
  type UndoNotInterestedResponse,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { FindAssetForAction } from '../../content/public.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { CommandKey, CommandLookup, JsonValue } from './ports.js';

export const NOT_INTERESTED_OPERATION = 'experience.not-interested';
export const NOT_INTERESTED_UNDO_OPERATION = 'experience.not-interested-undo';
const OUTCOME_VERSION = 1;

export type NotInterestedRefusal =
  'asset_not_found' | 'command_key_reused' | 'epoch_changed' | 'universe_unavailable' | 'outcome_from_newer_release';

export type NotInterestedResult<T> =
  | { readonly kind: 'applied'; readonly outcome: T }
  | { readonly kind: 'refused'; readonly reason: NotInterestedRefusal };

/** The rows of `experience.not_interested`, written and read inside the caller's personal scope. */
export interface NotInterestedStore {
  /** Marks the asset until the lapse time and returns it. Marking again restarts the clock. */
  mark(scope: PersonalScopeTx, assetId: string): Promise<Date>;
  /** Removes the mark; removing what is not there changes nothing. */
  unmark(scope: PersonalScopeTx, assetId: string): Promise<void>;
}

export interface NotInterestedPorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly hashRequest: (operation: string, request: JsonValue) => string;
  readonly findReceipt: (scope: PersonalScopeTx, key: CommandKey) => Promise<CommandLookup>;
  readonly insertReceipt: (scope: PersonalScopeTx, key: CommandKey) => Promise<void>;
  readonly completeReceipt: (
    scope: PersonalScopeTx,
    commandId: string,
    outcome: { readonly [key: string]: JsonValue },
  ) => Promise<void>;
  readonly findAsset: FindAssetForAction;
  readonly store: NotInterestedStore;
}

type Entered<T> = NotInterestedResult<T> | { readonly kind: 'new' };

/**
 * The receipt step every command here shares: an identical retry answers the stored outcome; a key
 * used for another request, or a receipt from before a privacy reset, is refused; an outcome from a
 * newer release is retried later, never applied again.
 */
function lookupOutcome<T>(lookup: CommandLookup, schema: z.ZodType<T>): Entered<T> {
  switch (lookup.kind) {
    case 'new':
      return { kind: 'new' };
    case 'replay':
      return { kind: 'applied', outcome: schema.parse({ ...(lookup.outcome as object), replayed: true }) };
    case 'outcome_version_newer':
      return { kind: 'refused', reason: 'outcome_from_newer_release' };
    case 'key_reused':
    case 'epoch_mismatch':
    case 'outcome_version_older':
      return { kind: 'refused', reason: 'command_key_reused' };
  }
}

function keyOf(ports: NotInterestedPorts, operation: string, command: { readonly commandId: string }, body: JsonValue) {
  return {
    commandId: command.commandId,
    operation,
    requestHash: ports.hashRequest(operation, body),
    outcomeVersion: OUTCOME_VERSION,
  };
}

function refusalOfScope(refusal: { readonly kind: string }): NotInterestedResult<never> {
  return {
    kind: 'refused',
    reason: refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable',
  };
}

/**
 * `POST /v1/feedback/not-interested`: keeps one admitted asset out of the caller's offers for
 * `NOT_INTERESTED_DAYS`.
 *
 * Authority: the caller's account and universe at their privacy epoch, rechecked under the personal
 * lock. One transaction: receipt lookup, asset admitted (`asset_not_found` otherwise, and nothing
 * is written), receipt, mark, outcome.
 * Effects: one `experience.not_interested` row and the receipt. It is no evidence: no action, no
 * observation, no job, and Personal Context never reads it.
 * Failure/retry: an exception rolls everything back; retrying with the same command ID is safe.
 */
export function makeSetNotInterested(ports: NotInterestedPorts) {
  return async (
    authority: PersonalAuthority,
    command: NotInterestedRequest,
  ): Promise<NotInterestedResult<NotInterestedResponse>> => {
    const key = keyOf(ports, NOT_INTERESTED_OPERATION, command, { assetId: command.assetId });
    const entered = await ports.withPersonalScope(
      authority,
      async (scope): Promise<NotInterestedResult<NotInterestedResponse>> => {
        const early = lookupOutcome(await ports.findReceipt(scope, key), NotInterestedResponseSchema);
        if (early.kind !== 'new') return early;
        const asset = await ports.findAsset(scope, command.assetId);
        if (!asset?.admitted) return { kind: 'refused', reason: 'asset_not_found' };
        await ports.insertReceipt(scope, key);
        const expiresAt = await ports.store.mark(scope, command.assetId);
        const outcome = NotInterestedResponseSchema.parse({
          commandId: command.commandId,
          assetId: command.assetId,
          expiresAt: expiresAt.toISOString(),
          replayed: false,
        });
        await ports.completeReceipt(scope, command.commandId, outcome);
        return { kind: 'applied', outcome };
      },
    );
    return entered.kind === 'entered' ? entered.value : refusalOfScope(entered.refusal);
  };
}

/**
 * `POST /v1/feedback/not-interested/undo`: lifts the constraint. It needs no asset check, so it
 * works for content that has since been withdrawn, and undoing what is not marked still succeeds.
 */
export function makeUndoNotInterested(ports: NotInterestedPorts) {
  return async (
    authority: PersonalAuthority,
    command: UndoNotInterestedRequest,
  ): Promise<NotInterestedResult<UndoNotInterestedResponse>> => {
    const key = keyOf(ports, NOT_INTERESTED_UNDO_OPERATION, command, { assetId: command.assetId });
    const entered = await ports.withPersonalScope(
      authority,
      async (scope): Promise<NotInterestedResult<UndoNotInterestedResponse>> => {
        const early = lookupOutcome(await ports.findReceipt(scope, key), UndoNotInterestedResponseSchema);
        if (early.kind !== 'new') return early;
        await ports.insertReceipt(scope, key);
        await ports.store.unmark(scope, command.assetId);
        const outcome = UndoNotInterestedResponseSchema.parse({
          commandId: command.commandId,
          assetId: command.assetId,
          replayed: false,
        });
        await ports.completeReceipt(scope, command.commandId, outcome);
        return { kind: 'applied', outcome };
      },
    );
    return entered.kind === 'entered' ? entered.value : refusalOfScope(entered.refusal);
  };
}

export type SetNotInterested = ReturnType<typeof makeSetNotInterested>;
export type UndoNotInterested = ReturnType<typeof makeUndoNotInterested>;
