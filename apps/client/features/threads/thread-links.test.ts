import { snippetHref, threadHref, threadRefFromParams, readInThreadHref } from './thread-links';

const ref = {
  threadId: '0199a000-0000-7000-8000-000000000001',
  membershipId: '0199a000-0000-7000-8000-000000000002',
  membershipRevision: 3,
};

describe('thread addresses', () => {
  it('carries the person’s own membership reference and reads it back', () => {
    expect(threadHref(ref)).toBe(`/threads/${ref.threadId}?m=${ref.membershipId}&r=3`);
    expect(snippetHref(ref, 'abc')).toBe(`/threads/${ref.threadId}/snippet/abc?m=${ref.membershipId}&r=3`);
    expect(readInThreadHref(ref, 'asset')).toBe(`/threads/${ref.threadId}/read/asset?m=${ref.membershipId}&r=3`);
    expect(threadRefFromParams({ threadId: ref.threadId, m: ref.membershipId, r: '3' })).toEqual(ref);
  });
  it('has no reference without a valid membership, and refuses a bad revision', () => {
    expect(threadRefFromParams({ threadId: ref.threadId })).toBeUndefined();
    expect(threadRefFromParams({ threadId: ref.threadId, m: 'not-a-uuid' })).toBeUndefined();
    expect(threadRefFromParams({ threadId: 'nope', m: ref.membershipId })).toBeUndefined();
    expect(threadRefFromParams({ threadId: ref.threadId, m: ref.membershipId, r: '0' })).toBeUndefined();
    expect(threadRefFromParams({ threadId: ref.threadId, m: ref.membershipId, r: '1.5' })).toBeUndefined();
  });
});
