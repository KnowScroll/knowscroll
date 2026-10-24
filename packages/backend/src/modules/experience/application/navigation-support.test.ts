import { describe, expect, it, vi } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { NavigationPorts } from './navigation-ports.js';
import { readWithheld } from './navigation-support.js';

const scope = {} as PersonalScopeTx;
const hidden = 'asset-hidden';
const marked = 'asset-marked';

function ports() {
  const readHidden = vi.fn((_scope: PersonalScopeTx, ids: readonly string[]) =>
    Promise.resolve(ids.filter((id) => id === hidden)),
  );
  const readNotInterested = vi.fn((_scope: PersonalScopeTx, ids: readonly string[]) =>
    Promise.resolve(ids.filter((id) => id === marked || id === hidden)),
  );
  return { readHidden, readNotInterested, ports: { readHidden, readNotInterested } as unknown as NavigationPorts };
}

describe('what a move leaves out (D-055)', () => {
  it('leaves out Hide and Not interested when Composer picks for the person, each asset once', async () => {
    const { ports: fake } = ports();
    expect(await readWithheld(fake, scope, [hidden, marked, 'asset-free'], false)).toEqual([hidden, marked]);
  });

  it('leaves out only Hide when the person named the target, without asking about Not interested', async () => {
    const { ports: fake, readNotInterested } = ports();
    expect(await readWithheld(fake, scope, [marked], true)).toEqual([]);
    expect(await readWithheld(fake, scope, [hidden], true)).toEqual([hidden]);
    expect(readNotInterested).not.toHaveBeenCalled();
  });

  it('asks nothing about no assets', async () => {
    const { ports: fake, readNotInterested } = ports();
    expect(await readWithheld(fake, scope, [], false)).toEqual([]);
    expect(readNotInterested).not.toHaveBeenCalled();
  });
});
