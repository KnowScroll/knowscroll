import { describe, expect, it } from 'vitest';
import {
  CancelContentRequestReceiptSchema,
  CancelContentRequestSchema,
  ContentRequestReceiptSchema,
  ContentRequestStatusSchema,
  CreateContentRequestSchema,
  ReadContentRequestSchema,
  RetryContentRequestReceiptSchema,
  RetryContentRequestSchema,
} from './index.js';

// Wire-only fixtures: no actual demand, admission, paid permission or personal activity.
const commandId = '0199f0a0-0000-7000-8000-000000000001';
const requestId = '0199f0a0-0000-7000-8000-000000000002';
const assetId = '0199f0a0-0000-7000-8000-000000000003';
const exposureId = '0199f0a0-0000-7000-8000-000000000004';
const sessionId = '0199f0a0-0000-7000-8000-000000000005';
const capabilities = { documentSchemas: ['scroll-document.v1'], blocks: { fallback: [1] } };
const source = { exposureId, assetId, assetRevision: 2 };
const subject = { kind: 'text', text: 'Explain why the high press works.' };
const intent = { kind: 'topic', subject, format: 'either' };
const create = { version: 'content-request.v1', commandId, intent, language: 'en', capabilities };
const variant = { ...create, intent: { kind: 'variant', source, to: 'scroll' } };
const receipt = {
  version: 'content-request-receipt.v1',
  commandId,
  requestId,
  recordedAt: '2026-10-21T10:00:00.000Z',
  privacyEpoch: 1,
  revision: 12,
  replayed: false,
  outcome: 'accepted',
};
const snapshot = {
  version: 'content-request-status.v1',
  requestId,
  privacyEpoch: 1,
  requestRevision: 2,
  revision: 13,
  createdAt: '2026-10-21T10:00:00.000Z',
  updatedAt: '2026-10-21T10:01:00.000Z',
};
const preparing = { ...snapshot, status: 'preparing', phase: 'requested' };
const content = {
  assetId,
  assetRevision: 3,
  explanationUnitId: 'wire-fixture-unit',
  metadata: { kind: 'scroll', title: 'Wire fixture', summary: 'Fixture metadata only.', language: 'en' },
};
const ready = { ...snapshot, status: 'ready', content };
const cancel = { version: 'content-request-cancel.v1', commandId, requestId };
const cancelReceipt = { ...receipt, version: 'content-request-cancel-receipt.v1', outcome: 'cancelled' };
const retry = { version: 'content-request-retry.v1', commandId, requestId };
const retryReceipt = { ...receipt, version: 'content-request-retry-receipt.v1', outcome: 'retrying' };

describe('Supply prerequisite wire contracts', () => {
  it('declares a fresh topic ask with either format and optional exact encounter context', () => {
    for (const format of ['reel', 'scroll', 'either']) {
      const topic = { ...create, intent: { ...intent, format } };
      expect(CreateContentRequestSchema.parse(topic)).toEqual(topic);
      const aboutThis = { ...topic, intent: { ...topic.intent, context: source } };
      expect(CreateContentRequestSchema.parse(aboutThis)).toEqual(aboutThis);
    }
    const session = { sessionId, expectedIntentRevision: 4 };
    const contextual = { ...create, intent: { ...intent, context: { ...source, session } } };
    expect(CreateContentRequestSchema.parse(contextual)).toEqual(contextual);
  });

  it('bounds text without trimming or transforming the submitted command', () => {
    const text = '  Explain this idea.  ';
    const padded = { ...create, intent: { ...intent, subject: { ...subject, text } } };
    expect(CreateContentRequestSchema.parse(padded)).toEqual(padded);
    expect(
      CreateContentRequestSchema.safeParse({
        ...create,
        intent: { ...intent, subject: { ...subject, text: 'x'.repeat(500) } },
      }).success,
    ).toBe(true);
    for (const text of ['', ' \t\n ', '\u2003', 'x'.repeat(501)])
      expect(
        CreateContentRequestSchema.safeParse({ ...create, intent: { ...intent, subject: { ...subject, text } } })
          .success,
      ).toBe(false);
  });

  it('validates catalogue-reference syntax while leaving exact membership and meaning to the backend', () => {
    const catalogue = {
      kind: 'catalogue',
      catalogueVersion: 'content-concepts.v1',
      topicId: 'earth.seasons',
      facetId: 'earth.seasons.axial-tilt',
    };
    for (const subject of [catalogue, { ...catalogue, topicId: 'not-in-the-catalogue' }]) {
      const request = { ...create, intent: { ...intent, subject } };
      expect(CreateContentRequestSchema.parse(request)).toEqual(request);
    }
    for (const subject of [
      { ...catalogue, catalogueVersion: 'content-concepts.v2' },
      { ...catalogue, topicId: '' },
      { ...catalogue, topicId: 'Earth Seasons' },
      { ...catalogue, topicId: 'x'.repeat(161) },
      { ...catalogue, facetId: 'x'.repeat(161) },
      { ...catalogue, meaning: 'Client assertion' },
      { ...catalogue, privateInterest: 0.9 },
    ])
      expect(CreateContentRequestSchema.safeParse({ ...create, intent: { ...intent, subject } }).success).toBe(false);
  });

  it('requires exact exposure lineage for a variant and permits only one requested format assertion', () => {
    for (const to of ['reel', 'scroll']) {
      const request = { ...variant, intent: { ...variant.intent, to } };
      expect(CreateContentRequestSchema.parse(request)).toEqual(request);
    }
    for (const intent of [
      { kind: 'variant', to: 'scroll' },
      { ...variant.intent, source: { assetId, assetRevision: 2 } },
      { ...variant.intent, source: { exposureId, assetId } },
      { ...variant.intent, source: { ...source, assetRevision: 0 } },
      { ...variant.intent, source: { ...source, assetRevision: 1.5 } },
      { ...variant.intent, source: { ...source, assetRevision: Number.MAX_SAFE_INTEGER + 1 } },
      { ...variant.intent, source: { ...source, session: { sessionId } } },
      { ...variant.intent, source: { ...source, session: { expectedIntentRevision: 4 } } },
      { ...variant.intent, to: 'either' },
      { ...variant.intent, format: 'reel' },
    ])
      expect(CreateContentRequestSchema.safeParse({ ...variant, intent }).success).toBe(false);
  });

  it('refuses deferred commissioning modes, arbitrary model controls and body authority assertions', () => {
    for (const kind of ['series_next', 'related', 'retry', 'what_if'])
      expect(CreateContentRequestSchema.safeParse({ ...create, intent: { ...intent, kind } }).success).toBe(false);
    for (const extra of [
      { ownerId: commandId },
      { privacyEpoch: 1 },
      { requestId },
      { sharingKey: 'private-context-hash' },
      { budgetGrantId: commandId },
      { model: 'arbitrary-model' },
      { prompt: 'private input' },
      { javascript: 'arbitrary code' },
      { threadId: commandId },
      { privateInterest: 0.9 },
    ])
      expect(CreateContentRequestSchema.safeParse({ ...create, ...extra }).success).toBe(false);
    for (const request of [
      { ...create, intent: { ...intent, to: 'scroll' } },
      { ...create, intent: { ...intent, subject: { ...subject, prompt: 'hidden' } } },
      { ...create, intent: { ...intent, context: { ...source, playheadMs: 12000 } } },
      { ...create, intent: { ...intent, context: { ...source, blockOffset: 12 } } },
      {
        ...create,
        intent: {
          ...intent,
          context: { ...source, session: { sessionId, expectedIntentRevision: 4, ownerId: commandId } },
        },
      },
    ])
      expect(CreateContentRequestSchema.safeParse(request).success).toBe(false);
  });

  it('retains canonical capabilities validation and bounded language without adding new canonical rules', () => {
    for (const request of [
      { ...create, capabilities: undefined },
      { ...create, capabilities: { documentSchemas: [], blocks: {} } },
      { ...create, capabilities: { ...capabilities, model: 'not-a-capability' } },
      { ...create, language: '' },
      { ...create, language: '   ' },
      { ...create, language: 'x'.repeat(36) },
    ])
      expect(CreateContentRequestSchema.safeParse(request).success).toBe(false);
  });

  it('keeps immutable acceptance separate from evolving current status on replay', () => {
    expect(ContentRequestReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(ContentRequestReceiptSchema.parse({ ...receipt, replayed: true })).toEqual({ ...receipt, replayed: true });
    expect(ContentRequestStatusSchema.parse(ready)).toEqual(ready);
    for (const invalid of [
      { ...receipt, status: 'ready', content },
      { ...receipt, outcome: 'ready' },
      { ...receipt, requestId: undefined },
      { ...receipt, phase: 'preparing' },
      ready,
    ])
      expect(ContentRequestReceiptSchema.safeParse(invalid).success).toBe(false);
    expect(ContentRequestStatusSchema.safeParse(receipt).success).toBe(false);
  });

  it('requires a real request identity for status reads and every honest availability state', () => {
    expect(ReadContentRequestSchema.parse({ requestId })).toEqual({ requestId });
    for (const state of [
      preparing,
      { ...preparing, phase: 'preparing' },
      ready,
      { ...snapshot, status: 'unavailable', reason: 'could_not_prepare' },
      { ...snapshot, status: 'cancelled' },
    ]) {
      expect(ContentRequestStatusSchema.parse(state)).toEqual(state);
      expect(ContentRequestStatusSchema.safeParse({ ...state, requestId: undefined }).success).toBe(false);
    }
    for (const read of [{}, { requestId: 'phantom' }, { requestId, retry: true }, { requestId, ownerId: commandId }])
      expect(ReadContentRequestSchema.safeParse(read).success).toBe(false);
  });

  it('never represents invented preparation targets, percentages, future parts or automatic activation', () => {
    for (const state of [
      { ...preparing, phase: undefined },
      { ...preparing, content },
      { ...preparing, target: { assetId, assetRevision: 3 } },
      { ...preparing, percent: 45 },
      { ...preparing, eta: 'soon' },
      { ...preparing, nextPart: 2, totalParts: 4 },
      { ...ready, offerId: commandId },
      { ...ready, exposureId },
      { ...ready, activatedAt: snapshot.updatedAt },
      { ...ready, content: { ...content, exposureId } },
      { ...ready, content: { ...content, assetRevision: undefined } },
      { ...snapshot, status: 'pending' },
    ])
      expect(ContentRequestStatusSchema.safeParse(state).success).toBe(false);
  });

  it('bounds ready metadata and refuses operational/private payloads at every response layer', () => {
    for (const extra of [
      { prompt: 'private' },
      { provenance: [] },
      { sources: [] },
      { score: 0.9 },
      { budgetBalance: 1 },
      { attemptId: commandId },
      { otherWaiters: [commandId] },
      { providerOutput: 'hidden' },
      { mediaUrl: 'https://example.invalid/media' },
    ]) {
      expect(ContentRequestStatusSchema.safeParse({ ...ready, ...extra }).success).toBe(false);
      expect(ContentRequestStatusSchema.safeParse({ ...ready, content: { ...content, ...extra } }).success).toBe(false);
      expect(
        ContentRequestStatusSchema.safeParse({
          ...ready,
          content: { ...content, metadata: { ...content.metadata, ...extra } },
        }).success,
      ).toBe(false);
      expect(ContentRequestReceiptSchema.safeParse({ ...receipt, ...extra }).success).toBe(false);
      expect(CancelContentRequestReceiptSchema.safeParse({ ...cancelReceipt, ...extra }).success).toBe(false);
    }
    for (const content of [
      { ...ready.content, explanationUnitId: 'x'.repeat(161) },
      { ...ready.content, metadata: { ...ready.content.metadata, title: 'x'.repeat(241) } },
      { ...ready.content, metadata: { ...ready.content.metadata, summary: 'x'.repeat(2001) } },
    ])
      expect(ContentRequestStatusSchema.safeParse({ ...ready, content }).success).toBe(false);
  });

  it('uses only fixed coarse unavailable reasons with no raw error or pending-work assertion', () => {
    for (const reason of [
      'unsupported_request',
      'no_compatible_supply',
      'not_permitted',
      'budget_unavailable',
      'could_not_prepare',
      'source_unavailable',
    ])
      expect(ContentRequestStatusSchema.safeParse({ ...snapshot, status: 'unavailable', reason }).success).toBe(true);
    for (const state of [
      { ...snapshot, status: 'unavailable', reason: 'provider said something private' },
      { ...snapshot, status: 'unavailable', reason: 'could_not_prepare', error: 'raw provider output' },
      { ...snapshot, status: 'unavailable', reason: 'could_not_prepare', phase: 'preparing' },
      { ...snapshot, status: 'cancelled', content },
    ])
      expect(ContentRequestStatusSchema.safeParse(state).success).toBe(false);
  });

  it('declares idempotent private cancellation separately from paid-attempt cancellation or refunds', () => {
    expect(CancelContentRequestSchema.parse(cancel)).toEqual(cancel);
    for (const outcome of ['cancelled', 'already_cancelled', 'already_closed']) {
      const result = { ...cancelReceipt, outcome };
      expect(CancelContentRequestReceiptSchema.parse(result)).toEqual(result);
      expect(CancelContentRequestReceiptSchema.parse({ ...result, replayed: true })).toEqual({
        ...result,
        replayed: true,
      });
    }
    for (const input of [
      { ...cancel, commandId: undefined },
      { ...cancel, requestId: undefined },
      { ...cancel, sharedJobId: commandId },
      { ...cancel, cancelProvider: true },
      { ...cancel, refund: true },
      { ...cancel, privacyEpoch: 1 },
    ])
      expect(CancelContentRequestSchema.safeParse(input).success).toBe(false);
    for (const result of [
      { ...cancelReceipt, outcome: 'refunded' },
      { ...cancelReceipt, outcome: 'provider_cancelled' },
      { ...cancelReceipt, status: 'cancelled' },
      { ...cancelReceipt, refundGuaranteed: true },
    ])
      expect(CancelContentRequestReceiptSchema.safeParse(result).success).toBe(false);
  });

  it('requires explicit versions, safe revisions, epochs and timestamps without cross-shape downgrade', () => {
    for (const [schema, value] of [
      [CreateContentRequestSchema, create],
      [ContentRequestReceiptSchema, receipt],
      [ContentRequestStatusSchema, preparing],
      [CancelContentRequestSchema, cancel],
      [CancelContentRequestReceiptSchema, cancelReceipt],
      [RetryContentRequestSchema, retry],
      [RetryContentRequestReceiptSchema, retryReceipt],
    ] as const) {
      expect(schema.safeParse({ ...value, version: undefined }).success).toBe(false);
      expect(schema.safeParse({ ...value, version: 'legacy.v0' }).success).toBe(false);
      expect(schema.safeParse({ ...value, unknown: true }).success).toBe(false);
    }
    for (const [schema, value] of [
      [ContentRequestReceiptSchema, receipt],
      [ContentRequestStatusSchema, preparing],
      [CancelContentRequestReceiptSchema, cancelReceipt],
    ] as const) {
      for (const privacyEpoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
        expect(schema.safeParse({ ...value, privacyEpoch }).success).toBe(false);
      for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
        expect(schema.safeParse({ ...value, revision }).success).toBe(false);
    }
    for (const requestRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(ContentRequestStatusSchema.safeParse({ ...preparing, requestRevision }).success).toBe(false);
    expect(ContentRequestReceiptSchema.safeParse({ ...receipt, recordedAt: 'yesterday' }).success).toBe(false);
    expect(ContentRequestStatusSchema.safeParse({ ...ready, updatedAt: 'tomorrow' }).success).toBe(false);
    expect(CancelContentRequestReceiptSchema.safeParse({ ...cancelReceipt, recordedAt: undefined }).success).toBe(
      false,
    );
  });

  it('declares retry as the same request again: own command, its ID and a closed set of outcomes', () => {
    expect(RetryContentRequestSchema.parse(retry)).toEqual(retry);
    for (const outcome of ['retrying', 'already_open', 'not_retryable']) {
      const result = { ...retryReceipt, outcome };
      expect(RetryContentRequestReceiptSchema.parse(result)).toEqual(result);
      expect(RetryContentRequestReceiptSchema.parse({ ...result, replayed: true }).replayed).toBe(true);
    }
    for (const input of [
      { ...retry, commandId: undefined },
      { ...retry, requestId: undefined },
      { ...retry, intent },
      { ...retry, provider: 'minimax' },
      { ...retry, force: true },
    ])
      expect(RetryContentRequestSchema.safeParse(input).success).toBe(false);
    for (const result of [
      { ...retryReceipt, outcome: 'ready' },
      { ...retryReceipt, outcome: 'resent' },
      { ...retryReceipt, status: 'preparing' },
      { ...retryReceipt, newRequestId: requestId },
    ])
      expect(RetryContentRequestReceiptSchema.safeParse(result).success).toBe(false);
  });
});

describe('Ask from here (D1, D-218)', () => {
  const askIntent = {
    kind: 'ask',
    source,
    anchor: { kind: 'stop', stopId: 'call-delhi' },
    question: 'Why do we not feel the change in distance at all?',
    recordingGeneration: 1,
  };
  const ask = { ...create, intent: askIntent };

  it('declares a question from one stop of the exact Scroll the person is reading, with the recording generation', () => {
    expect(CreateContentRequestSchema.parse(ask)).toEqual(ask);
    expect(
      CreateContentRequestSchema.safeParse({
        ...ask,
        intent: { ...askIntent, source: { ...source, session: { sessionId, expectedIntentRevision: 4 } } },
      }).success,
    ).toBe(true);
    for (const missing of ['source', 'anchor', 'question', 'recordingGeneration'])
      expect(
        CreateContentRequestSchema.safeParse({ ...ask, intent: { ...askIntent, [missing]: undefined } }).success,
      ).toBe(false);
  });

  it('bounds the words and the stop, and keeps format, topic, scope and anything the model decides out of it', () => {
    for (const question of ['', ' ', 'ab', 'x'.repeat(281)])
      expect(CreateContentRequestSchema.safeParse({ ...ask, intent: { ...askIntent, question } }).success).toBe(false);
    expect(
      CreateContentRequestSchema.safeParse({ ...ask, intent: { ...askIntent, question: 'x'.repeat(280) } }).success,
    ).toBe(true);
    for (const anchor of [
      { kind: 'stop', stopId: '' },
      { kind: 'stop', stopId: 'x'.repeat(65) },
      { kind: 'passage', text: 'a quote' },
      { kind: 'stop' },
    ])
      expect(CreateContentRequestSchema.safeParse({ ...ask, intent: { ...askIntent, anchor } }).success).toBe(false);
    for (const extra of [
      { format: 'reel' },
      { topicId: 'earth.tides' },
      { scope: 'here' },
      { model: 'x' },
      { prompt: 'x' },
      { context: source },
    ])
      expect(CreateContentRequestSchema.safeParse({ ...ask, intent: { ...askIntent, ...extra } }).success).toBe(false);
    expect(
      CreateContentRequestSchema.safeParse({ ...ask, intent: { ...askIntent, recordingGeneration: 0 } }).success,
    ).toBe(false);
    expect(
      CreateContentRequestSchema.safeParse({ ...ask, intent: { ...askIntent, source: { ...source, playheadMs: 1 } } })
        .success,
    ).toBe(false);
  });

  it('shows a usual time only as measured whole seconds on a preparing request, never as a promise', () => {
    expect(ContentRequestStatusSchema.parse({ ...preparing, typicalSeconds: 130 })).toMatchObject({
      typicalSeconds: 130,
    });
    expect(ContentRequestStatusSchema.safeParse(preparing).success).toBe(true);
    for (const typicalSeconds of [0, -1, 1.5, 86_401, '2 min', null])
      expect(ContentRequestStatusSchema.safeParse({ ...preparing, typicalSeconds }).success).toBe(false);
    // A closed or ready request has no time to wait.
    expect(ContentRequestStatusSchema.safeParse({ ...ready, typicalSeconds: 130 }).success).toBe(false);
    expect(
      ContentRequestStatusSchema.safeParse({ ...snapshot, status: 'cancelled', typicalSeconds: 130 }).success,
    ).toBe(false);
  });
});
