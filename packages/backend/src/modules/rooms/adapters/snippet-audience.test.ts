import { describe, expect, it, vi } from 'vitest';
import type { CheckAssetAudience, ResolveSnippetAnchor, ValidateSnippetAnchor } from '../../content/public.js';
import { gateSnippetAnchors } from './snippet-audience.js';

const scope = { authority: { universeId: 'u', privacyEpoch: 1, actor: { kind: 'account', accountId: 'a' } } } as never;
const target = { assetId: '0199d000-0000-7000-8000-000000000001', assetRevision: 1 };
const anchor = { kind: 'reel_range', startMs: 1000, endMs: 5000 } as never;

describe('Rooms’ gate on snippet reads', () => {
  it('treats a Scroll made for a thread as unavailable to a room, and never asks Content about it', async () => {
    const check = vi.fn<CheckAssetAudience>(() => Promise.resolve(new Set()));
    const validate = vi.fn<ValidateSnippetAnchor>(() => Promise.resolve({ status: 'invalid' }));
    const resolve = vi.fn<ResolveSnippetAnchor>(() => Promise.resolve({ status: 'unavailable' }));
    const gated = gateSnippetAnchors(check, validate, resolve);
    expect(await gated.validateSnippet(scope, target, anchor)).toEqual({ status: 'unavailable' });
    expect(await gated.resolveSnippet(scope, target, anchor)).toEqual({ status: 'unavailable' });
    expect(validate).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledWith({ scope }, expect.anything(), [target.assetId]);
  });

  it('hands a reachable Scroll to Content unchanged', async () => {
    const check = vi.fn<CheckAssetAudience>((_on, _authority, ids) => Promise.resolve(new Set(ids)));
    const validate = vi.fn<ValidateSnippetAnchor>(() => Promise.resolve({ status: 'invalid' }));
    const resolve = vi.fn<ResolveSnippetAnchor>(() => Promise.resolve({ status: 'unavailable' }));
    const gated = gateSnippetAnchors(check, validate, resolve);
    expect(await gated.validateSnippet(scope, target, anchor)).toEqual({ status: 'invalid' });
    expect(validate).toHaveBeenCalledTimes(1);
    await gated.resolveSnippet(scope, target, anchor);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
