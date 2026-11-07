import { describe, expect, it, vi } from 'vitest';
import type { LibraryFindSource } from '../../content/public.js';
import type { ReadOwnSystemTopic } from '../../geography/public.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import { makeReadSystemFinds, pickBothFormats, type SystemFindsPorts } from './system-finds.js';

const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const authority: PersonalAuthority = {
  universeId: id(1),
  privacyEpoch: 3,
  actor: { kind: 'account', accountId: id(2) },
};
const scope = { authority, revisionAtEntry: 11 } as unknown as PersonalScopeTx;
const systemId = id(3);
const input = { version: 'universe-system-finds.v1', readId: id(4), systemId };
const find = (n: number, kind: 'reel' | 'scroll'): LibraryFindSource => ({
  assetId: id(100 + n),
  assetRevision: 1,
  kind,
  title: `${kind} ${String(n)}`,
  summary: 'A summary',
});
type Topic = Awaited<ReturnType<ReadOwnSystemTopic>>;

function fixture(over: Partial<SystemFindsPorts> & { topics?: Topic[] } = {}) {
  const topics = [...(over.topics ?? [])];
  const withPersonalScope: WithPersonalScope = (_authority, work) =>
    work(scope).then((value) => ({ kind: 'entered', value }));
  const readSystemTopic = vi.fn<ReadOwnSystemTopic>(() =>
    Promise.resolve(topics.shift() ?? { kind: 'read', systemId, topicId: 'machine-learning' }),
  );
  const library = [find(1, 'scroll'), find(2, 'reel'), find(3, 'scroll')];
  const readFinds = vi.fn<SystemFindsPorts['readFinds']>((_topic, _limit, _only, _within, format) =>
    Promise.resolve(library.filter((x) => x.kind === format)),
  );
  const readWithheld = vi.fn(() => Promise.resolve([] as string[]));
  const ports: SystemFindsPorts = {
    withPersonalScope,
    readSystemTopic,
    readFinds,
    readWithheld,
    ...(over.readFinds ? { readFinds: over.readFinds } : {}),
    ...(over.readWithheld ? { readWithheld: over.readWithheld } : {}),
  };
  return { read: makeReadSystemFinds(ports), readSystemTopic, readFinds: ports.readFinds };
}

describe('a system’s Reels and Scrolls (#697)', () => {
  it('lists the Reels and Scrolls of an own system, newest first, read for the system’s whole topic', async () => {
    const f = fixture();
    expect(await f.read(authority, input)).toEqual({
      kind: 'read',
      finds: {
        version: 'universe-system-finds.v1',
        readId: id(4),
        universeId: id(1),
        privacyEpoch: 3,
        personalWatermark: 11,
        systemId,
        status: 'ready',
        finds: [
          { assetId: id(102), assetRevision: 1, kind: 'reel', title: 'reel 2' },
          { assetId: id(101), assetRevision: 1, kind: 'scroll', title: 'scroll 1' },
          { assetId: id(103), assetRevision: 1, kind: 'scroll', title: 'scroll 3' },
        ],
      },
    });
    // Each format is read on its own, so a run of new Scrolls can never hide the Reels.
    const of = { kind: 'system', id: 'machine-learning' };
    expect(f.readFinds).toHaveBeenCalledWith(of, 24, undefined, undefined, 'reel');
    expect(f.readFinds).toHaveBeenCalledWith(of, 24, undefined, undefined, 'scroll');
    // Checked once before the library is read and again after, so a map that changed meanwhile is never answered from.
    expect(f.readSystemTopic).toHaveBeenCalledTimes(2);
  });

  it('leaves out what the person hid or set aside', async () => {
    const f = fixture({ readWithheld: vi.fn(() => Promise.resolve([id(102)])) });
    const result = await f.read(authority, input);
    expect(result.kind === 'read' && result.finds.status === 'ready' && result.finds.finds.map((x) => x.kind)).toEqual([
      'scroll',
      'scroll',
    ]);
  });

  it('says the library holds nothing yet with an empty ready answer, never an error', async () => {
    const f = fixture({ readFinds: vi.fn(() => Promise.resolve([])) });
    const result = await f.read(authority, input);
    expect(result.kind === 'read' && result.finds).toMatchObject({ status: 'ready', finds: [] });
  });

  it('answers temporarily_unavailable when the library cannot be read, never an empty system', async () => {
    const f = fixture({ readFinds: vi.fn(() => Promise.reject(new Error('pool down'))) });
    const result = await f.read(authority, input);
    expect(result.kind === 'read' && result.finds).toMatchObject({
      status: 'unavailable',
      reason: 'temporarily_unavailable',
    });
  });

  it('answers not_on_map for a system that is not the person’s own, without reading the library', async () => {
    const away: Topic = { kind: 'unavailable', reason: 'not_on_map' };
    const f = fixture({ topics: [away, away] });
    const result = await f.read(authority, input);
    expect(result.kind === 'read' && result.finds).toMatchObject({ status: 'unavailable', reason: 'not_on_map' });
    expect(f.readFinds).not.toHaveBeenCalled();
  });

  it('does not answer from rows read for a topic the system no longer has', async () => {
    const f = fixture({
      topics: [
        { kind: 'read', systemId, topicId: 'machine-learning' },
        { kind: 'read', systemId, topicId: 'earth' },
      ],
    });
    const result = await f.read(authority, input);
    expect(result.kind === 'read' && result.finds).toMatchObject({
      status: 'unavailable',
      reason: 'temporarily_unavailable',
    });
  });

  it('refuses a malformed request and an owner who is no longer active', async () => {
    expect(await fixture().read(authority, { ...input, systemId: 'x' })).toEqual({
      kind: 'refused',
      code: 'INVALID_REQUEST',
    });
    expect(await fixture({ topics: [{ kind: 'refused' }] }).read(authority, input)).toEqual({
      kind: 'refused',
      code: 'UNIVERSE_UNAVAILABLE',
    });
  });
});

describe('both formats stay in view', () => {
  it('keeps the Reels of a system even when more Scrolls were made lately, in the library’s order', () => {
    const sources = [...Array.from({ length: 20 }, (_, n) => find(n, 'scroll')), find(30, 'reel'), find(31, 'reel')];
    const picked = pickBothFormats(sources);
    expect(picked).toHaveLength(12);
    expect(picked.filter((x) => x.kind === 'reel')).toHaveLength(2);
    expect(picked).toEqual(sources.filter((x) => picked.includes(x)));
  });
});
