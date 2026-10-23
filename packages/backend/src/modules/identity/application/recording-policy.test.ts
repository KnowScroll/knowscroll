import { describe, expect, it } from 'vitest';
import { makeRecordingPolicy } from './recording-policy.js';
import type { RecordingPorts, StoredRecordingCommand } from './recording-ports.js';
import type { PersonalScopeTx } from '../public.js';
const accountId = '11111111-1111-4111-8111-111111111111';
const universeId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';
const authority = { universeId, privacyEpoch: 1, actor: { kind: 'account' as const, accountId } };
const body = {
  version: 'recording-policy.v1' as const,
  commandId,
  expectedPrivacyEpoch: 1,
  expectedRecordingGeneration: 1,
  on: false,
};
/** Synthetic ports only. SQL atomicity/lifetime/lock races are separately exercised in Actions PG. */
function fixture() {
  let command: StoredRecordingCommand | undefined,
    lookups = 0,
    writes = 0;
  const current = { accountId, revision: 0, policy: { on: true, generation: 1 } };
  const scope = { authority, revisionAtEntry: 0 } as unknown as PersonalScopeTx;
  const ports: RecordingPorts = {
    withScope: (_authority, work) => work(scope).then((value) => ({ kind: 'entered', value })),
    fenceOwn: () => Promise.resolve({ kind: 'active', owner: { accountId, universeId, privacyEpoch: 1 } }),
    store: {
      current: () => Promise.resolve(current),
      command: () => {
        lookups++;
        return Promise.resolve(command);
      },
      accept: (_s, _c, accepted) => {
        writes++;
        command = accepted;
        return Promise.resolve();
      },
    },
    hash: (q) => JSON.stringify([q.version, q.commandId, q.expectedPrivacyEpoch, q.expectedRecordingGeneration, q.on]),
    now: () => new Date('2026-10-23T00:00:00.000Z'),
  };
  return { ports, current, cases: makeRecordingPolicy(ports), counts: () => ({ lookups, writes }) };
}
describe('recording policy decisions (synthetic ports)', () => {
  it('records exact toggles, replays after newer policy and rejects changed original bodies', async () => {
    const f = fixture();
    const first = await f.cases.set(authority, body);
    expect(first).toMatchObject({
      kind: 'ok',
      value: { replayed: false, receipt: { fromGeneration: 1, toGeneration: 2, changed: true, on: false } },
    });
    f.current.policy = { on: true, generation: 3 };
    expect(await f.cases.set(authority, body)).toMatchObject({
      kind: 'ok',
      value: { replayed: true, receipt: { toGeneration: 2, on: false } },
    });
    expect(await f.cases.set(authority, { ...body, on: true })).toEqual({
      kind: 'refused',
      code: 'command_key_reused',
    });
    expect(f.counts().writes).toBe(1);
  });
  it('no-op retains generation; stale and exhausted commands have no effect', async () => {
    const f = fixture();
    expect(await f.cases.set(authority, { ...body, on: true })).toMatchObject({
      kind: 'ok',
      value: { receipt: { changed: false, fromGeneration: 1, toGeneration: 1 } },
    });
    const stale = fixture();
    stale.current.policy.generation = 3;
    expect(await stale.cases.set(authority, body)).toEqual({ kind: 'refused', code: 'stale_policy' });
    const exhausted = fixture();
    exhausted.current.policy.generation = 2147483647;
    expect(await exhausted.cases.set(authority, { ...body, expectedRecordingGeneration: 2147483647 })).toEqual({
      kind: 'refused',
      code: 'generation_exhausted',
    });
    exhausted.current.revision = 2147483647;
    expect(
      await exhausted.cases.set(authority, { ...body, expectedRecordingGeneration: 2147483647, on: true }),
    ).toEqual({ kind: 'refused', code: 'revision_exhausted' });
    expect(stale.counts().writes + exhausted.counts().writes).toBe(0);
  });
  it('checks current authority before lookup and current reads never write', async () => {
    const f = fixture();
    const unavailable = makeRecordingPolicy({ ...f.ports, fenceOwn: () => Promise.resolve({ kind: 'unavailable' }) });
    expect(await unavailable.set(authority, body)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(f.counts()).toEqual({ lookups: 0, writes: 0 });
    const g = fixture();
    const input = { version: 'recording-policy.v1', readId: commandId, target: { kind: 'current' } };
    expect(await g.cases.read(authority, input)).toMatchObject({
      kind: 'ok',
      value: { ...input, revision: 0, policy: { on: true, generation: 1 } },
    });
    expect(g.counts()).toEqual({ lookups: 0, writes: 0 });
    expect(await g.cases.set(authority, { ...body, extra: true })).toEqual({ kind: 'refused', code: 'invalid_input' });
  });
});
