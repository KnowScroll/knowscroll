import { describe, expect, it, vi } from 'vitest';
import { createReportFlow, reportedPersonOf, type FeedbackTarget, type ReportFlowOptions } from './feedback-flow';
import type { QueuedReport, ReportOutcome } from './feedback-store';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
let counter = 100;
const newId = () => id(counter++);
const receipt = { commandId: id(0), reportId: id(7), receivedAt: '2026-10-24T22:11:00.000Z', replayed: false };
const kiran = { personId: id(5), displayName: 'Kiran', handle: 'kiran.dev' };

const reel: FeedbackTarget = {
  kind: 'asset',
  assetId: id(1),
  assetRevision: 2,
  title: 'Attention, explained with a crowded sentence',
  format: 'reel',
  anchor: { kind: 'reel', positionMs: 31_000 },
};

function flowFor(
  target: FeedbackTarget,
  start: ReportFlowOptions['start'],
  outcomes: ReportOutcome[] = [{ status: 'received', receipt }],
) {
  const sendReport = vi.fn((_report: QueuedReport) =>
    Promise.resolve(outcomes.shift() ?? { status: 'received' as const, receipt }),
  );
  const blockPerson = vi.fn((_personId: string) => Promise.resolve(true));
  const flow = createReportFlow({ target, start, newId, store: { sendReport, blockPerson } });
  return { flow, sendReport, blockPerson };
}

describe('the menu', () => {
  it('opens a form and goes back to the menu from it, but a message has no menu to go back to', () => {
    const { flow } = flowFor(reel, 'menu');
    expect(flow.getState().step).toBe('menu');
    flow.chooseAbuse();
    expect(flow.getState()).toMatchObject({ step: 'abuse', kind: 'abuse' });
    expect(flow.back()).toBe(true);
    expect(flow.getState().step).toBe('menu');
    flow.chooseContentError();
    expect(flow.getState()).toMatchObject({ step: 'content_error', kind: 'content_error' });

    const direct = flowFor({ kind: 'message', messageId: id(3) }, 'abuse').flow;
    expect(direct.getState().step).toBe('abuse');
    expect(direct.back()).toBe(false);
  });

  it('offers a content error only for a Reel or Scroll', () => {
    const { flow } = flowFor({ kind: 'person', person: kiran }, 'abuse');
    flow.chooseContentError();
    expect(flow.getState()).toMatchObject({ step: 'abuse', kind: 'abuse' });
  });
});

describe('a content error', () => {
  it('starts on "Something’s wrong" and can be sent at once, with the moment it was at', async () => {
    const { flow, sendReport } = flowFor(reel, 'content_error');
    expect(flow.getState()).toMatchObject({ contentCategory: 'wrong', canSend: true, anchored: true });
    await flow.send();
    expect(sendReport).toHaveBeenCalledWith({
      kind: 'content_error',
      request: {
        commandId: expect.any(String) as string,
        target: { assetId: id(1), assetRevision: 2 },
        category: 'wrong',
        anchor: { kind: 'reel', positionMs: 31_000 },
      },
    });
    expect(flow.getState()).toMatchObject({ step: 'received', receipt });
  });

  it('names the Quick answer it is about, so the server can keep its words (D-255)', async () => {
    const { flow, sendReport } = flowFor(
      { ...reel, format: 'scroll', anchor: { kind: 'scroll', blockId: 'the-lean' }, quickAnswerId: id(60) },
      'content_error',
    );
    await flow.send();
    expect(sendReport).toHaveBeenCalledWith({
      kind: 'content_error',
      request: {
        commandId: expect.any(String) as string,
        target: { assetId: id(1), assetRevision: 2 },
        category: 'wrong',
        anchor: { kind: 'scroll', blockId: 'the-lean' },
        quickAnswerId: id(60),
      },
    });
    // A report about a Scroll alone names no Quick answer.
    const plain = flowFor({ ...reel, format: 'scroll', anchor: undefined }, 'content_error');
    await plain.flow.send();
    expect(plain.sendReport.mock.calls[0]![0]).toMatchObject({ kind: 'content_error' });
    expect(JSON.stringify(plain.sendReport.mock.calls[0]![0])).not.toContain('quickAnswerId');
  });

  it('takes a reason and a note, trims the note, drops a note of spaces and can leave the moment out', async () => {
    const { flow, sendReport } = flowFor(reel, 'content_error');
    flow.setContentCategory('out_of_date');
    flow.setNote('  “it” could also mean the street here?  ');
    flow.toggleAnchor();
    await flow.send();
    expect(sendReport.mock.calls[0]![0]).toMatchObject({
      request: { category: 'out_of_date', note: '“it” could also mean the street here?' },
    });
    expect(sendReport.mock.calls[0]![0].request).not.toHaveProperty('anchor');

    const blank = flowFor(reel, 'content_error');
    blank.flow.setNote('    ');
    await blank.flow.send();
    expect(blank.sendReport.mock.calls[0]![0].request).not.toHaveProperty('note');
  });

  it('cuts a note at the limit the server takes', () => {
    const { flow } = flowFor(reel, 'content_error');
    flow.setNote('x'.repeat(600));
    expect(flow.getState().note).toHaveLength(500);
  });

  it('has no moment to point to on a Scroll without a position', () => {
    const { flow } = flowFor({ ...reel, format: 'scroll', anchor: undefined }, 'content_error');
    expect(flow.getState().anchored).toBe(false);
    flow.toggleAnchor();
    expect(flow.getState().anchored).toBe(false);
  });
});

describe('an abuse report', () => {
  it('cannot be sent until a reason is picked, and then names the message and not its words', async () => {
    const { flow, sendReport } = flowFor({ kind: 'message', messageId: id(3), author: kiran }, 'abuse');
    expect(flow.getState().canSend).toBe(false);
    await flow.send();
    expect(sendReport).not.toHaveBeenCalled();
    expect(flow.getState().step).toBe('abuse');
    flow.setAbuseCategory('harassment');
    expect(flow.getState().canSend).toBe(true);
    await flow.send();
    expect(sendReport.mock.calls[0]![0]).toEqual({
      kind: 'abuse',
      request: {
        commandId: expect.any(String) as string,
        target: { kind: 'message', messageId: id(3) },
        category: 'harassment',
      },
    });
  });

  it('names a room message, a person and a Reel or Scroll the way the server expects', async () => {
    for (const [target, expected] of [
      [{ kind: 'room_message', messageId: id(4) } as const, { kind: 'room_message', messageId: id(4) }],
      [{ kind: 'person', person: kiran } as const, { kind: 'person', personId: id(5) }],
      [reel, { kind: 'asset', assetId: id(1), assetRevision: 2 }],
    ] as const) {
      const { flow, sendReport } = flowFor(target, 'abuse');
      flow.setAbuseCategory('spam');
      await flow.send();
      expect(sendReport.mock.calls[0]![0].request).toMatchObject({ target: expected, category: 'spam' });
    }
  });
});

describe('sending', () => {
  it('shows sending, then the receipt, and ignores a second tap on either', async () => {
    const { flow, sendReport } = flowFor(reel, 'content_error');
    const steps: string[] = [];
    flow.subscribe(() => steps.push(flow.getState().step));
    const first = flow.send();
    void flow.send();
    await first;
    await flow.send();
    expect(steps).toEqual(['sending', 'received']);
    expect(sendReport).toHaveBeenCalledTimes(1);
  });

  it('says it is queued when there was no answer, and is done with it', async () => {
    const { flow } = flowFor(reel, 'content_error', [{ status: 'queued' }]);
    await flow.send();
    expect(flow.getState().step).toBe('queued');
    await flow.send();
    expect(flow.getState().step).toBe('queued');
  });

  it('fails with a retry that repeats the same command ID, and a new ID once the form is changed', async () => {
    const { flow, sendReport } = flowFor(reel, 'content_error', [
      { status: 'refused', reason: 'try_again' },
      { status: 'refused', reason: 'try_again' },
      { status: 'received', receipt },
    ]);
    await flow.send();
    expect(flow.getState()).toMatchObject({ step: 'failed', failure: 'try_again' });
    await flow.send();
    const [first, second] = sendReport.mock.calls.map((call) => call[0].request.commandId);
    expect(second).toBe(first);

    flow.setNote('One more thing');
    expect(flow.getState()).toMatchObject({ step: 'content_error', failure: undefined });
    await flow.send();
    expect(sendReport.mock.calls[2]![0].request.commandId).not.toBe(first);
    expect(flow.getState().step).toBe('received');
  });

  it('names a refusal that a retry cannot fix', async () => {
    for (const reason of ['unavailable', 'too_many'] as const) {
      const { flow } = flowFor(reel, 'abuse', [{ status: 'refused', reason }]);
      flow.setAbuseCategory('hate');
      await flow.send();
      expect(flow.getState()).toMatchObject({ step: 'failed', failure: reason });
    }
  });
});

describe('Also block', () => {
  it('is offered for a person, blocks once and says whether it worked', async () => {
    const { flow, blockPerson } = flowFor({ kind: 'message', messageId: id(3), author: kiran }, 'abuse');
    expect(flow.getState().block).toBe('offered');
    await flow.block();
    expect(blockPerson).toHaveBeenCalledWith(id(5));
    expect(flow.getState().block).toBe('blocked');
    await flow.block();
    expect(blockPerson).toHaveBeenCalledTimes(1);
  });

  it('says when it failed, and can be tried again', async () => {
    const { flow, blockPerson } = flowFor({ kind: 'person', person: kiran }, 'abuse');
    blockPerson.mockResolvedValueOnce(false);
    await flow.block();
    expect(flow.getState().block).toBe('failed');
    await flow.block();
    expect(flow.getState().block).toBe('blocked');
  });

  it('is not offered when no person is named: a Reel, or an AI inhabitant’s message', async () => {
    for (const target of [reel, { kind: 'room_message', messageId: id(4) } as const]) {
      const { flow, blockPerson } = flowFor(target, 'abuse');
      expect(flow.getState().block).toBe('unavailable');
      await flow.block();
      expect(blockPerson).not.toHaveBeenCalled();
    }
    expect(reportedPersonOf(reel)).toBeUndefined();
  });
});
