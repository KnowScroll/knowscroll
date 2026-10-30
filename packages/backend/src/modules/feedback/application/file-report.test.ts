import { describe, expect, it, vi } from 'vitest';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import { REPORTS_PER_WINDOW } from '../domain/reports.js';
import { makeReportUseCases } from './file-report.js';
import type { NewReport, ReceiptKey, ReceiptLookup, ReportPorts } from './ports.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const reporter = id(2);
const authority: PersonalAuthority = {
  universeId: id(1),
  privacyEpoch: 1,
  actor: { kind: 'account', accountId: reporter },
};
const scope = { authority } as unknown as PersonalScopeTx;
const now = new Date('2026-10-24T12:00:00.000Z');
const otherPerson = id(3);

interface Options {
  readonly lookup?: ReceiptLookup;
  readonly fenced?: boolean;
  readonly sentToday?: number;
  readonly asset?: { revision: number; admitted: boolean; revisionReleased?: boolean } | undefined;
  /** Collects what the asset read was asked for: the asset and the revision named. */
  readonly asked?: unknown[][];
  readonly message?: { authorAccountId: string } | undefined;
  readonly roomMessage?: { roomId: string; authorAccountId: string | null } | undefined;
  readonly person?: string | undefined;
}

/** Ports over memory: the target reads answer what the test says, and every write is logged. */
function fixture(options: Options = {}) {
  const inserted: NewReport[] = [];
  const receipts = new Map<string, { key: ReceiptKey; outcome?: Record<string, unknown> }>();
  const withScope: WithPersonalScope = (_authority, work) => work(scope).then((value) => ({ kind: 'entered', value }));
  const ports: ReportPorts = {
    withScope,
    fenceOwn: () =>
      Promise.resolve(
        options.fenced === false
          ? { kind: 'unavailable' }
          : { kind: 'active', owner: { accountId: reporter, universeId: id(1), privacyEpoch: 1 } },
      ),
    hash: (operation, request) => `${operation}:${JSON.stringify(request)}`,
    findReceipt: (_scope, key) => {
      if (options.lookup) return Promise.resolve(options.lookup);
      const stored = receipts.get(key.commandId);
      if (!stored) return Promise.resolve({ kind: 'new' });
      return Promise.resolve(
        stored.key.requestHash === key.requestHash
          ? { kind: 'replay', outcome: stored.outcome }
          : { kind: 'key_reused' },
      );
    },
    insertReceipt: (_scope, key) => {
      receipts.set(key.commandId, { key });
      return Promise.resolve();
    },
    completeReceipt: (_scope, commandId, outcome) => {
      receipts.get(commandId)!.outcome = { ...outcome };
      return Promise.resolve();
    },
    findAsset: (_scope, assetId, revision) => {
      options.asked?.push([assetId, revision]);
      return Promise.resolve('asset' in options ? options.asset : { revision: 3, admitted: true });
    },
    readMessage: () => Promise.resolve('message' in options ? options.message : { authorAccountId: otherPerson }),
    readRoomMessage: () =>
      Promise.resolve(
        'roomMessage' in options ? options.roomMessage : { roomId: id(40), authorAccountId: otherPerson },
      ),
    readPeople: () =>
      Promise.resolve(
        ('person' in options ? options.person : otherPerson) === undefined
          ? []
          : [{ accountId: ('person' in options ? options.person : otherPerson)!, person: {} as never }],
      ),
    reports: {
      countSince: vi.fn(() => Promise.resolve(options.sentToday ?? 0)),
      insert: (_scope, report) => {
        inserted.push(report);
        return Promise.resolve();
      },
    },
    newId: () => id(99),
    now: () => now,
  };
  return { ports, inserted, receipts, cases: makeReportUseCases(ports) };
}

const abuse = (target: unknown, commandId = id(20)) =>
  ({ commandId, category: 'harassment', target }) as Parameters<
    ReturnType<typeof makeReportUseCases>['reportAbuse']
  >[1];

describe('a content error report', () => {
  const command = {
    commandId: id(20),
    target: { assetId: id(10), assetRevision: 2 },
    category: 'wrong' as const,
    anchor: { kind: 'reel' as const, positionMs: 31_000 },
    note: 'It could also mean the street here.',
  };

  it('is stored with its anchor and note and answered with a receipt', async () => {
    const { cases, inserted } = fixture();
    const result = await cases.reportContentError(authority, command);
    expect(result).toEqual({
      kind: 'received',
      outcome: { commandId: id(20), reportId: id(99), receivedAt: now.toISOString(), replayed: false },
    });
    expect(inserted).toEqual([
      {
        reportId: id(99),
        reporterAccountId: reporter,
        kind: 'content_error',
        category: 'wrong',
        targetKind: 'asset',
        assetId: id(10),
        assetRevision: 2,
        anchor: { kind: 'reel', positionMs: 31_000 },
        note: 'It could also mean the street here.',
        createdAt: now,
      },
    ]);
  });

  it('refuses an asset the caller cannot reach, a withdrawn one, and a revision it never had', async () => {
    for (const asset of [undefined, { revision: 3, admitted: false }, { revision: 1, admitted: true }]) {
      const { cases, inserted, receipts } = fixture({ asset });
      expect(await cases.reportContentError(authority, command)).toEqual({
        kind: 'refused',
        reason: 'target_unavailable',
      });
      expect(inserted).toEqual([]);
      expect(receipts.size).toBe(0);
    }
  });

  it('refuses a revision the review gate held or rejected, which no one was ever served, and asks for the one named', async () => {
    const { cases, inserted } = fixture({ asset: { revision: 3, admitted: true, revisionReleased: false } });
    expect(await cases.reportContentError(authority, command)).toEqual({
      kind: 'refused',
      reason: 'target_unavailable',
    });
    expect(inserted).toEqual([]);
    const asked: unknown[][] = [];
    const { cases: released } = fixture({ asset: { revision: 3, admitted: true, revisionReleased: true }, asked });
    expect(await released.reportContentError(authority, command)).toMatchObject({ kind: 'received' });
    expect(asked).toEqual([[command.target.assetId, command.target.assetRevision]]);
  });
});

describe('an abuse report', () => {
  it('names a message by the person who wrote it, never by what it said', async () => {
    const { cases, inserted } = fixture();
    await cases.reportAbuse(authority, abuse({ kind: 'message', messageId: id(30) }));
    expect(inserted[0]).toMatchObject({
      kind: 'abuse',
      targetKind: 'message',
      messageId: id(30),
      reportedAccountId: otherPerson,
    });
    expect(JSON.stringify(inserted[0])).not.toContain('text');
  });

  it('keeps the room of a room message so its moderators can see it', async () => {
    const { cases, inserted } = fixture();
    await cases.reportAbuse(authority, abuse({ kind: 'room_message', messageId: id(31) }));
    expect(inserted[0]).toMatchObject({ targetKind: 'room_message', roomId: id(40), reportedAccountId: otherPerson });
  });

  it('accepts an AI inhabitant message, which has no person behind it', async () => {
    const { cases, inserted } = fixture({ roomMessage: { roomId: id(40), authorAccountId: null } });
    expect(await cases.reportAbuse(authority, abuse({ kind: 'room_message', messageId: id(31) }))).toMatchObject({
      kind: 'received',
    });
    expect(inserted[0]).not.toHaveProperty('reportedAccountId');
  });

  it('names a person by account, and an asset like a content error', async () => {
    const { cases, inserted } = fixture();
    await cases.reportAbuse(authority, abuse({ kind: 'person', personId: id(50) }));
    await cases.reportAbuse(authority, abuse({ kind: 'asset', assetId: id(10), assetRevision: 3 }, id(21)));
    expect(inserted.map((report) => report.targetKind)).toEqual(['person', 'asset']);
    expect(inserted[0]).toMatchObject({ reportedAccountId: otherPerson });
  });

  it('gives one answer for a target that is missing, out of sight or the reporter’s own', async () => {
    const cases = [
      fixture({ message: undefined }),
      fixture({ message: { authorAccountId: reporter } }),
      fixture({ roomMessage: undefined }),
      fixture({ roomMessage: { roomId: id(40), authorAccountId: reporter } }),
      fixture({ person: undefined }),
      fixture({ person: reporter }),
    ];
    const targets = [
      { kind: 'message', messageId: id(30) },
      { kind: 'message', messageId: id(30) },
      { kind: 'room_message', messageId: id(31) },
      { kind: 'room_message', messageId: id(31) },
      { kind: 'person', personId: id(50) },
      { kind: 'person', personId: id(50) },
    ];
    for (const [index, world] of cases.entries()) {
      expect(await world.cases.reportAbuse(authority, abuse(targets[index]))).toEqual({
        kind: 'refused',
        reason: 'target_unavailable',
      });
      expect(world.inserted).toEqual([]);
    }
  });
});

describe('every report', () => {
  const message = abuse({ kind: 'message', messageId: id(30) });

  it('answers an identical retry from its receipt and stores one row', async () => {
    const { cases, inserted } = fixture();
    await cases.reportAbuse(authority, message);
    const again = await cases.reportAbuse(authority, message);
    expect(again).toMatchObject({ kind: 'received', outcome: { reportId: id(99), replayed: true } });
    expect(inserted).toHaveLength(1);
  });

  it('stores a new command about a target already reported as a new report, with its own receipt', async () => {
    const { cases, inserted, receipts } = fixture();
    const target = { kind: 'person', personId: id(50) };
    expect(await cases.reportAbuse(authority, abuse(target, id(21)))).toMatchObject({
      kind: 'received',
      outcome: { commandId: id(21), replayed: false },
    });
    // A month later, another reason and a note: the safety team must get it.
    const again = {
      ...abuse(target, id(22)),
      category: 'hate' as const,
      note: 'Threats, described.',
    };
    expect(await cases.reportAbuse(authority, again)).toMatchObject({
      kind: 'received',
      outcome: { commandId: id(22), replayed: false },
    });
    expect(inserted.map((report) => [report.category, report.note])).toEqual([
      ['harassment', undefined],
      ['hate', 'Threats, described.'],
    ]);
    expect(receipts.size).toBe(2);
  });

  it('refuses a command ID reused for another report', async () => {
    const { cases } = fixture();
    await cases.reportAbuse(authority, message);
    expect(await cases.reportAbuse(authority, abuse({ kind: 'person', personId: id(50) }))).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
  });

  it('stops at the daily bound and writes nothing', async () => {
    const { cases, inserted, receipts } = fixture({ sentToday: REPORTS_PER_WINDOW });
    expect(await cases.reportAbuse(authority, message)).toEqual({ kind: 'refused', reason: 'too_many_reports' });
    expect(inserted).toEqual([]);
    expect(receipts.size).toBe(0);
  });

  it('refuses an account whose gate is not open before reading anything', async () => {
    const { cases, ports } = fixture({ fenced: false });
    const read = vi.spyOn(ports, 'readMessage');
    expect(await cases.reportAbuse(authority, message)).toEqual({ kind: 'refused', reason: 'universe_unavailable' });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not re-apply an outcome a newer release stored', async () => {
    const { cases, inserted } = fixture({ lookup: { kind: 'outcome_version_newer' } });
    expect(await cases.reportAbuse(authority, message)).toEqual({
      kind: 'refused',
      reason: 'outcome_from_newer_release',
    });
    expect(inserted).toEqual([]);
  });
});
