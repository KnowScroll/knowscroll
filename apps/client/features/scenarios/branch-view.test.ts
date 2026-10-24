import type { ScenarioCard } from '@knowscroll/contracts';
import { branchViewOf } from './branch-view';

const card = (patch: Partial<ScenarioCard> = {}): ScenarioCard => ({
  nodeId: '0199a000-0000-7000-8000-000000000009',
  kind: 'what_if',
  origin: 'root',
  title: 'What if the tilt were different?',
  changes: [],
  kept: [],
  hypothetical: true,
  speculative: false,
  assumptions: [],
  status: 'ready',
  revision: 1,
  createdAt: '2026-10-24T10:00:00.000Z',
  content: { kind: 'scroll', assetId: '0199a000-0000-7000-8000-0000000000aa', assetRevision: 1, title: 'A Scroll' },
  ...patch,
});

describe('what a branch address shows', () => {
  it('shows the branch by its card, and calls it removed only when its card says so', () => {
    expect(branchViewOf('ready', 'ready', card())).toMatchObject({ kind: 'ready' });
    expect(branchViewOf('ready', 'ready', card({ status: 'preparing', content: undefined }))).toMatchObject({
      kind: 'preparing',
    });
    expect(branchViewOf('ready', 'ready', card({ status: 'failed', content: undefined }))).toMatchObject({
      kind: 'branch_failed',
    });
    expect(branchViewOf('ready', 'ready', card({ status: 'removed', content: undefined }))).toEqual({
      kind: 'removed',
    });
    expect(branchViewOf('ready', 'ready', undefined)).toEqual({ kind: 'missing' });
  });

  it('puts what could not be read before what the card says: the thread, then a failed read, then waiting', () => {
    expect(branchViewOf('unavailable', 'ready', card())).toEqual({ kind: 'thread_unavailable' });
    expect(branchViewOf('invitation', 'ready', card())).toEqual({ kind: 'thread_unavailable' });
    expect(branchViewOf('ready', 'unavailable', undefined)).toEqual({ kind: 'thread_unavailable' });
    expect(branchViewOf('failed', 'ready', card())).toEqual({ kind: 'failed' });
    expect(branchViewOf('ready', 'failed', undefined)).toEqual({ kind: 'failed' });
    expect(branchViewOf('loading', 'ready', card())).toEqual({ kind: 'loading' });
    expect(branchViewOf('ready', 'loading', undefined)).toEqual({ kind: 'loading' });
  });

  it('never says removed for an unknown branch, a thread that is not theirs, or a failed read', () => {
    const shown = [
      branchViewOf('ready', 'ready', undefined),
      branchViewOf('unavailable', 'unavailable', undefined),
      branchViewOf('failed', 'failed', undefined),
    ];
    expect(shown.map((view) => view.kind)).not.toContain('removed');
  });
});
