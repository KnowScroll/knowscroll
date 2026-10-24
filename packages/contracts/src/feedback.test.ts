import { describe, expect, it } from 'vitest';
import {
  AbuseReportRequestSchema,
  ContentErrorReportRequestSchema,
  NotInterestedRequestSchema,
  NotInterestedResponseSchema,
  ReportReceiptSchema,
  UndoNotInterestedRequestSchema,
  apiContract,
  feedbackContract,
} from './index.js';

// Synthetic wire fixtures only.
const id = (n: number) => `019b7dc2-83fe-7000-8000-${String(n).padStart(12, '0')}`;
const target = { assetId: id(1), assetRevision: 2 };

describe('Not interested', () => {
  it('names one asset and a command, and nothing else', () => {
    expect(NotInterestedRequestSchema.parse({ commandId: id(2), assetId: id(1) })).toEqual({
      commandId: id(2),
      assetId: id(1),
    });
    expect(UndoNotInterestedRequestSchema.safeParse({ commandId: id(2), assetId: id(1) }).success).toBe(true);
    for (const extra of [{ reason: 'boring' }, { topic: 'football' }, { assetRevision: 1 }])
      expect(NotInterestedRequestSchema.safeParse({ commandId: id(2), assetId: id(1), ...extra }).success).toBe(false);
  });

  it('answers when the constraint lapses, as a time', () => {
    expect(
      NotInterestedResponseSchema.safeParse({
        commandId: id(2),
        assetId: id(1),
        expiresAt: '2026-11-07T12:00:00.000Z',
        replayed: false,
      }).success,
    ).toBe(true);
    expect(
      NotInterestedResponseSchema.safeParse({ commandId: id(2), assetId: id(1), expiresAt: 'soon', replayed: false })
        .success,
    ).toBe(false);
  });
});

describe('a content error report', () => {
  const report = { commandId: id(2), target, category: 'wrong' };

  it('takes the exact revision, a reason from the form, and an optional place and note', () => {
    expect(ContentErrorReportRequestSchema.parse(report)).toEqual(report);
    const full = {
      ...report,
      anchor: { kind: 'reel', positionMs: 31_000 },
      note: '“it” could also mean the street here?',
    };
    expect(ContentErrorReportRequestSchema.parse(full)).toEqual(full);
    expect(
      ContentErrorReportRequestSchema.safeParse({ ...report, anchor: { kind: 'scroll', blockId: 'intro-look-up' } })
        .success,
    ).toBe(true);
  });

  it('refuses a reason the form does not offer, an abuse reason, a bad place and extra fields', () => {
    for (const bad of [
      { category: 'harassment' },
      { category: 'Wrong' },
      { anchor: { kind: 'reel', positionMs: -1 } },
      { anchor: { kind: 'reel', positionMs: 1.5 } },
      { anchor: { kind: 'scroll', blockId: '' } },
      { anchor: { kind: 'reel', positionMs: 1, blockId: 'x' } },
      { target: { assetId: id(1) } },
      { reporterAccountId: id(9) },
    ])
      expect(ContentErrorReportRequestSchema.safeParse({ ...report, ...bad }).success).toBe(false);
  });
});

describe('an abuse report', () => {
  const report = { commandId: id(2), category: 'harassment' };

  it('names a Reel or Scroll, a message, a room message or a person, never a name or text', () => {
    for (const aim of [
      { kind: 'asset', ...target },
      { kind: 'message', messageId: id(3) },
      { kind: 'room_message', messageId: id(3) },
      { kind: 'person', personId: id(4) },
    ])
      expect(AbuseReportRequestSchema.parse({ ...report, target: aim }).target).toEqual(aim);
    for (const bad of [
      { kind: 'message', messageId: id(3), text: 'what they said' },
      { kind: 'person', handle: 'ravi' },
      { kind: 'message' },
      { kind: 'conversation', conversationId: id(5) },
    ])
      expect(AbuseReportRequestSchema.safeParse({ ...report, target: bad }).success).toBe(false);
  });

  it('needs a reason, from the list', () => {
    const aim = { kind: 'person', personId: id(4) };
    expect(AbuseReportRequestSchema.safeParse({ commandId: id(2), target: aim }).success).toBe(false);
    expect(AbuseReportRequestSchema.safeParse({ ...report, target: aim, category: 'rude' }).success).toBe(false);
    for (const category of ['harassment', 'hate', 'sexual_content', 'violence', 'spam', 'self_harm', 'other'])
      expect(AbuseReportRequestSchema.safeParse({ ...report, target: aim, category }).success).toBe(true);
  });

  it('keeps the note plain and short', () => {
    const aim = { kind: 'person', personId: id(4) };
    const withNote = (note: string) => AbuseReportRequestSchema.safeParse({ ...report, target: aim, note }).success;
    expect(withNote('He keeps doing this.\nEvery day.')).toBe(true);
    expect(withNote('x'.repeat(500))).toBe(true);
    expect(withNote('x'.repeat(501))).toBe(false);
    expect(withNote('')).toBe(false);
    expect(withNote('hidden\u0000byte')).toBe(false);
    expect(withNote('right-to-left\u0085mark')).toBe(false);
  });
});

describe('what a sender gets back', () => {
  it('is a receipt that names the report and the time and nothing about the target', () => {
    const receipt = { commandId: id(2), reportId: id(7), receivedAt: '2026-10-24T22:11:00.000Z', replayed: false };
    expect(ReportReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(Object.keys(ReportReceiptSchema.shape).sort()).toEqual(['commandId', 'receivedAt', 'replayed', 'reportId']);
    expect(ReportReceiptSchema.safeParse({ ...receipt, reportedPersonId: id(4) }).success).toBe(false);
  });

  it('is the only way to read a report: the feedback routes are commands, and none returns a stored report', () => {
    expect(Object.keys(feedbackContract).sort()).toEqual([
      'notInterested',
      'reportAbuse',
      'reportContentError',
      'undoNotInterested',
    ]);
    for (const route of Object.values(apiContract.feedback)) {
      expect(route['~orpc'].route).toMatchObject({ method: 'POST', successStatus: 200 });
      expect(route['~orpc'].route.path).toMatch(/^\/v1\/feedback\//);
    }
  });
});
