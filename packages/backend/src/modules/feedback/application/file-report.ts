import {
  ReportReceiptSchema,
  type AbuseReportRequest,
  type ContentErrorReportRequest,
  type ReportReceipt,
} from '@knowscroll/contracts';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { reportsExhausted, windowStart } from '../domain/reports.js';
import type { NewReport, ReceiptLookup, ReportKind, ReportPorts } from './ports.js';

export const CONTENT_ERROR_OPERATION = 'feedback.content-error';
export const ABUSE_OPERATION = 'feedback.abuse';
const OUTCOME_VERSION = 1;

export type ReportRefusal =
  | 'target_unavailable'
  | 'too_many_reports'
  | 'command_key_reused'
  | 'epoch_changed'
  | 'universe_unavailable'
  | 'outcome_from_newer_release';

export type ReportResult =
  | { readonly kind: 'received'; readonly outcome: ReportReceipt }
  | { readonly kind: 'refused'; readonly reason: ReportRefusal };

const refused = (reason: ReportRefusal): ReportResult => ({ kind: 'refused', reason });

/** What the target of a report turned out to be: the fields of `NewReport` that name it. */
type ResolvedTarget = Pick<
  NewReport,
  'targetKind' | 'assetId' | 'assetRevision' | 'messageId' | 'roomId' | 'reportedAccountId' | 'quickAnswer'
>;

interface ReportSpec {
  readonly kind: ReportKind;
  readonly operation: string;
  readonly commandId: string;
  readonly category: string;
  readonly note: string | undefined;
  readonly anchor?: Readonly<Record<string, unknown>>;
  /** Exactly what the person asked for: its hash is what a retry must repeat. */
  readonly request: unknown;
  /** The target as the caller may see it, or nothing. `caller` is the reporter's account. */
  resolve(scope: PersonalScopeTx, caller: string): Promise<ResolvedTarget | undefined>;
}

function replayOrRefusal(lookup: ReceiptLookup): ReportResult | undefined {
  switch (lookup.kind) {
    case 'new':
      return undefined;
    case 'replay':
      return {
        kind: 'received',
        outcome: ReportReceiptSchema.parse({ ...(lookup.outcome as object), replayed: true }),
      };
    case 'outcome_version_newer':
      return refused('outcome_from_newer_release');
    case 'key_reused':
    case 'epoch_mismatch':
    case 'outcome_version_older':
      return refused('command_key_reused');
  }
}

/**
 * The skeleton of every report. One transaction under the personal root and the reporter's own account:
 * receipt lookup (an identical retry answers the first receipt), the target as the caller may see it
 * (otherwise `target_unavailable`, the same answer for a missing, forbidden or own target), the daily
 * bound, then the receipt, the row and the stored outcome together. A refusal writes nothing. A new
 * command about a target already reported is a new report: what it says may be new (another reason, a
 * note, a later event), so every command ID gets its own row and receipt.
 * Nothing else happens: nobody is notified, no job runs, and no evidence is recorded.
 */
async function fileReport(ports: ReportPorts, authority: PersonalAuthority, spec: ReportSpec): Promise<ReportResult> {
  const key = {
    commandId: spec.commandId,
    operation: spec.operation,
    requestHash: ports.hash(spec.operation, spec.request),
    outcomeVersion: OUTCOME_VERSION,
  };
  const entered = await ports.withScope(authority, async (scope): Promise<ReportResult> => {
    const gate = await ports.fenceOwn(scope);
    if (gate.kind !== 'active') return refused('universe_unavailable');
    const reporter = gate.owner.accountId;
    const early = replayOrRefusal(await ports.findReceipt(scope, key));
    if (early !== undefined) return early;
    const target = await spec.resolve(scope, reporter);
    if (target === undefined) return refused('target_unavailable');
    const now = ports.now();
    if (reportsExhausted(await ports.reports.countSince(scope, reporter, windowStart(now))))
      return refused('too_many_reports');
    await ports.insertReceipt(scope, key);
    const reportId = ports.newId();
    await ports.reports.insert(scope, {
      reportId,
      reporterAccountId: reporter,
      kind: spec.kind,
      category: spec.category,
      ...target,
      ...(spec.anchor === undefined ? {} : { anchor: spec.anchor }),
      ...(spec.note === undefined ? {} : { note: spec.note }),
      createdAt: now,
    });
    const outcome = ReportReceiptSchema.parse({
      commandId: spec.commandId,
      reportId,
      receivedAt: now.toISOString(),
      replayed: false,
    });
    await ports.completeReceipt(scope, spec.commandId, outcome);
    return { kind: 'received', outcome };
  });
  if (entered.kind === 'entered') return entered.value;
  return refused(entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable');
}

/** An asset the caller may reach, at a revision it really has. */
async function resolveAsset(
  ports: ReportPorts,
  scope: PersonalScopeTx,
  target: { readonly assetId: string; readonly assetRevision: number },
): Promise<ResolvedTarget | undefined> {
  const asset = await ports.findAsset(scope, target.assetId, target.assetRevision);
  // A revision the review gate held or rejected was never served, so no one can have met it to report it.
  if (!asset?.admitted || asset.revision < target.assetRevision || asset.revisionReleased === false) return undefined;
  return { targetKind: 'asset', assetId: target.assetId, assetRevision: target.assetRevision };
}

/**
 * The Scroll a content error is about and, when it is about a Quick answer, the words of that answer as the person's own
 * copy holds them (D-255). A Quick answer that is not theirs, not answered, past its day or about another revision is
 * a missing target, the same answer as for a missing Scroll.
 */
async function resolveContentError(
  ports: ReportPorts,
  scope: PersonalScopeTx,
  command: ContentErrorReportRequest,
): Promise<ResolvedTarget | undefined> {
  const target = await resolveAsset(ports, scope, command.target);
  if (target === undefined || command.quickAnswerId === undefined) return target;
  const quickAnswer = await ports.readQuickAnswer(scope, { quickAnswerId: command.quickAnswerId, ...command.target });
  return quickAnswer === undefined ? undefined : { ...target, quickAnswer };
}

/** Another person's account, never the reporter's own: reporting oneself says nothing to the safety team. */
const notSelf = (caller: string, account: string | null | undefined): string | undefined =>
  account === caller ? undefined : (account ?? undefined);

async function resolveAbuseTarget(
  ports: ReportPorts,
  scope: PersonalScopeTx,
  caller: string,
  target: AbuseReportRequest['target'],
): Promise<ResolvedTarget | undefined> {
  switch (target.kind) {
    case 'asset':
      return resolveAsset(ports, scope, target);
    case 'message': {
      const message = await ports.readMessage(scope, caller, target.messageId);
      const author = notSelf(caller, message?.authorAccountId);
      return message === undefined || author === undefined
        ? undefined
        : { targetKind: 'message', messageId: target.messageId, reportedAccountId: author };
    }
    case 'room_message': {
      const message = await ports.readRoomMessage(scope, caller, target.messageId);
      if (message === undefined || message.authorAccountId === caller) return undefined;
      return {
        targetKind: 'room_message',
        messageId: target.messageId,
        roomId: message.roomId,
        // An inhabitant's message has no account behind it.
        ...(message.authorAccountId === null ? {} : { reportedAccountId: message.authorAccountId }),
      };
    }
    case 'person': {
      const [found] = await ports.readPeople(scope, { personIds: [target.personId] });
      const account = notSelf(caller, found?.accountId);
      return account === undefined ? undefined : { targetKind: 'person', reportedAccountId: account };
    }
  }
}

export function makeReportUseCases(ports: ReportPorts) {
  return {
    /** `POST /v1/feedback/content-errors`: something in a Reel or Scroll seems wrong. */
    reportContentError: (authority: PersonalAuthority, command: ContentErrorReportRequest) =>
      fileReport(ports, authority, {
        kind: 'content_error',
        operation: CONTENT_ERROR_OPERATION,
        commandId: command.commandId,
        category: command.category,
        note: command.note,
        ...(command.anchor === undefined ? {} : { anchor: command.anchor }),
        request: {
          target: command.target,
          category: command.category,
          anchor: command.anchor,
          note: command.note,
          quickAnswerId: command.quickAnswerId,
        },
        resolve: (scope) => resolveContentError(ports, scope, command),
      }),

    /** `POST /v1/feedback/abuse-reports`: a Reel or Scroll, a message or a person is abusive. */
    reportAbuse: (authority: PersonalAuthority, command: AbuseReportRequest) =>
      fileReport(ports, authority, {
        kind: 'abuse',
        operation: ABUSE_OPERATION,
        commandId: command.commandId,
        category: command.category,
        note: command.note,
        request: { target: command.target, category: command.category, note: command.note },
        resolve: (scope, caller) => resolveAbuseTarget(ports, scope, caller, command.target),
      }),
  };
}

export type ReportUseCases = ReturnType<typeof makeReportUseCases>;
