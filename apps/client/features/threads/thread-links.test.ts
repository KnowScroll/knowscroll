import {
  branchHref,
  partFromParam,
  readInThreadHref,
  snippetHref,
  threadHref,
  threadRefFromParams,
} from './thread-links';

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
    expect(readInThreadHref(ref, 'asset', 2)).toBe(`/threads/${ref.threadId}/read/asset?m=${ref.membershipId}&r=3&p=2`);
    expect(branchHref(ref, 'node')).toBe(`/threads/${ref.threadId}/b/node?m=${ref.membershipId}&r=3`);
    expect(threadRefFromParams({ threadId: ref.threadId, m: ref.membershipId, r: '3' })).toEqual(ref);
  });
  it('reads a part number back from a reader address, and nothing that is not a part', () => {
    expect(partFromParam('2')).toBe(2);
    for (const value of [undefined, '', '0', '100', '1.5', '-1', 'two']) expect(partFromParam(value)).toBeUndefined();
  });
  it('has no reference without a valid membership, and refuses a bad revision', () => {
    expect(threadRefFromParams({ threadId: ref.threadId })).toBeUndefined();
    expect(threadRefFromParams({ threadId: ref.threadId, m: 'not-a-uuid' })).toBeUndefined();
    expect(threadRefFromParams({ threadId: 'nope', m: ref.membershipId })).toBeUndefined();
    expect(threadRefFromParams({ threadId: ref.threadId, m: ref.membershipId, r: '0' })).toBeUndefined();
    expect(threadRefFromParams({ threadId: ref.threadId, m: ref.membershipId, r: '1.5' })).toBeUndefined();
  });
});
