import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { ComposerDecision, ComposerSnapshot, PreparedEvidenceInput } from '../domain/types.js';
export type ComposeEncounter = (snapshot: ComposerSnapshot) => ComposerDecision;
/** Implemented by the later evidence projector. Absence is explicit; never manufactures history. */
export type ReadPreparedEvidenceInput = (
  scope: PersonalScopeTx,
  query: { readonly evaluatedAt: string; readonly topicIds: readonly string[] },
) => Promise<PreparedEvidenceInput | undefined>;
export interface DecisionBinding {
  readonly decisionId: string;
  readonly commandId: string;
  readonly sessionId?: string;
  readonly intentRevision?: number;
}
export type PersistComposerDecision = (
  scope: PersonalScopeTx,
  binding: DecisionBinding,
  decision: ComposerDecision,
) => Promise<'stored' | 'replayed'>;
/** Authenticated operator adapter only. It rechecks the composition root's allowlist and own live scope. */
export type ReadComposerDecision = (
  scope: PersonalScopeTx,
  decisionId: string,
) => Promise<
  { readonly binding: DecisionBinding; readonly decision: ComposerDecision; readonly inputSha256: string } | undefined
>;
export type PruneComposerDecisions = (scope: PersonalScopeTx, limit: number) => Promise<number>;
export interface ComposerOperatorAccess {
  readonly isOperator: (authority: PersonalAuthority) => boolean;
}
