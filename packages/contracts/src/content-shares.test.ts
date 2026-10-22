import { describe, expect, it } from 'vitest';
import {
  CreateContentShareSchema,
  CreateContentShareResultSchema,
  ContentShareCreationAcceptanceSchema,
  ResolvedContentShareSchema,
  ResolveContentShareSchema,
  OwnContentShareSchema,
  RevokeContentShareSchema,
  ContentShareRevocationAcceptanceSchema,
} from './content-shares.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const scope = { accountId: id(1), privacyEpoch: 2 };
const conversation = { conversationId: id(2), membershipId: id(3), membershipRevision: 1 };
const target = { assetId: id(4), assetRevision: 7 };
const metadata = { kind: 'reel', title: 'An exact public card', summary: 'Public metadata only', language: 'en' };
const version = 'content-share.v1';
const token = 'kssh_' + 'a'.repeat(43);
const receipt = {
  version,
  scope,
  commandId: id(5),
  operation: 'content-share.create',
  shareId: id(6),
  target,
  audience: { kind: 'public_metadata' },
  outcome: 'accepted',
  replayed: false,
  recordedAt: '2026-10-22T00:00:00.000Z',
  expiresAt: '2026-10-23T00:00:00.000Z',
};
const read = { version, readId: id(7) };

describe('whole exact-content share prerequisite (no endpoint or granted access)', () => {
  it.each(['public_metadata', 'conversation'] as const)(
    'binds %s to immutable full content, never player/thread/snippet state',
    (kind) => {
      const audience = kind === 'conversation' ? { kind, conversation } : { kind };
      const command = { version, commandId: id(5), target, audience };
      expect(CreateContentShareSchema.parse(command)).toEqual(command);
      for (const extra of [
        { positionMs: 12000 },
        { anchor: id(8) },
        { snippet: 'private text' },
        { threadId: id(8) },
        { forceAccess: true },
      ])
        expect(CreateContentShareSchema.safeParse({ ...command, ...extra }).success).toBe(false);
      expect(CreateContentShareSchema.safeParse({ ...command, target: { assetId: target.assetId } }).success).toBe(
        false,
      );
      expect(
        CreateContentShareSchema.safeParse({ ...command, audience: { kind: 'chosen_friends', personIds: [id(8)] } })
          .success,
      ).toBe(false);
    },
  );
  it('separates first secret delivery from immutable receipt/replay and finite original expiry', () => {
    expect(
      CreateContentShareResultSchema.safeParse({ acceptance: receipt, delivery: { status: 'available', token } })
        .success,
    ).toBe(true);
    expect(
      CreateContentShareResultSchema.safeParse({
        acceptance: { ...receipt, replayed: true },
        delivery: { status: 'unavailable' },
      }).success,
    ).toBe(true);
    expect(
      CreateContentShareResultSchema.safeParse({
        acceptance: { ...receipt, replayed: true },
        delivery: { status: 'available', token },
      }).success,
    ).toBe(false);
    expect(ContentShareCreationAcceptanceSchema.safeParse({ ...receipt, token }).success).toBe(false);
    expect(ContentShareCreationAcceptanceSchema.safeParse({ ...receipt, expiresAt: receipt.recordedAt }).success).toBe(
      false,
    );
    expect(
      CreateContentShareResultSchema.safeParse({ acceptance: receipt, delivery: { status: 'unavailable', token } })
        .success,
    ).toBe(false);
    expect(RevokeContentShareSchema.parse({ version, commandId: id(9), shareId: id(6) })).toEqual({
      version,
      commandId: id(9),
      shareId: id(6),
    });
    expect(
      ContentShareRevocationAcceptanceSchema.safeParse({
        version,
        scope,
        commandId: id(9),
        shareId: id(6),
        recordedAt: receipt.recordedAt,
        replayed: true,
        outcome: 'accepted',
        operation: 'content-share.revoke',
      }).success,
    ).toBe(true);
  });
  it('keeps public metadata identical for every caller and excludes all relationship/grant facts', () => {
    const value = { ...read, status: 'public_metadata', content: { status: 'available', target, metadata } };
    expect(ResolvedContentShareSchema.parse(value)).toEqual(value);
    for (const extra of [
      { scope },
      { conversation },
      { sender: { personId: id(8) } },
      { blocked: true },
      { mediaUrl: 'https://private.invalid/credential' },
      { exposureId: id(8) },
      { playbackGrant: id(8) },
    ])
      expect(ResolvedContentShareSchema.safeParse({ ...value, ...extra }).success).toBe(false);
    expect(
      ResolvedContentShareSchema.safeParse({
        ...value,
        content: { ...value.content, metadata: { ...metadata, sourceUrl: 'https://private.invalid' } },
      }).success,
    ).toBe(false);
  });
  it('makes every denied/unknown/revoked/expired/private/withdrawn landing one neutral body', () => {
    const neutral = { ...read, status: 'unavailable' };
    expect(ResolvedContentShareSchema.parse(neutral)).toEqual(neutral);
    for (const extra of [
      { reason: 'revoked' },
      { senderName: 'Friend' },
      { title: 'Old title' },
      { content: target },
      { exists: true },
      { conversation },
      { scope },
      { token },
    ])
      expect(ResolvedContentShareSchema.safeParse({ ...neutral, ...extra }).success).toBe(false);
    for (const status of ['blocked', 'private', 'revoked', 'expired', 'withdrawn', 'access_required'])
      expect(ResolvedContentShareSchema.safeParse({ ...read, status }).success).toBe(false);
  });
  it('permits authorized private exact/corrected metadata, never silent replacement', () => {
    const content = { status: 'corrected', target, current: { ...target, assetRevision: 8, metadata } };
    expect(
      ResolvedContentShareSchema.safeParse({ ...read, status: 'conversation', scope, conversation, content }).success,
    ).toBe(true);
    expect(
      ResolvedContentShareSchema.safeParse({ ...read, status: 'conversation', conversation, content }).success,
    ).toBe(false);
    expect(
      ResolvedContentShareSchema.safeParse({
        ...read,
        status: 'public_metadata',
        content: { ...content, current: { ...target, metadata } },
      }).success,
    ).toBe(false);
  });
  it('recovers only current own minimal resource with exact selector, not a new old-epoch command', () => {
    const value = {
      ...read,
      scope,
      status: 'available',
      selector: { kind: 'share', shareId: id(6) },
      shareId: id(6),
      target,
      audience: { kind: 'conversation', conversation },
      state: 'revoked',
      expiresAt: receipt.expiresAt,
    };
    expect(OwnContentShareSchema.parse(value)).toEqual(value);
    expect(OwnContentShareSchema.safeParse({ ...value, shareId: id(8) }).success).toBe(false);
    expect(OwnContentShareSchema.safeParse({ ...value, selector: { kind: 'command', commandId: id(5) } }).success).toBe(
      true,
    );
    for (const extra of [{ token }, { oldMessageBody: 'private' }, { executeAgain: true }])
      expect(OwnContentShareSchema.safeParse({ ...value, ...extra }).success).toBe(false);
    expect(
      OwnContentShareSchema.safeParse({ ...read, scope, status: 'unavailable', selector: value.selector, target })
        .success,
    ).toBe(false);
  });
  it('accepts only a sensitive JSON token and no API URL, foreign capability or extra state', () => {
    expect(ResolveContentShareSchema.parse({ ...read, token })).toEqual({ ...read, token });
    for (const bad of [
      'https://example.invalid/s/' + token,
      'ksfi_' + 'a'.repeat(43),
      'kssh_' + 'a'.repeat(42),
      token + '=',
    ])
      expect(ResolveContentShareSchema.safeParse({ ...read, token: bad }).success).toBe(false);
    expect(ResolveContentShareSchema.safeParse({ ...read, token, peerAccountId: id(8) }).success).toBe(false);
  });
});
