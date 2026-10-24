import { describe, expect, it } from 'vitest';
import { operatorAddressMatcher } from '../../identity/public.js';
import { makeIsOperator } from './operator-access.js';

const matchers = ['owner@example.com', '*@test.knowscroll.space'].map((entry) => {
  const matcher = operatorAddressMatcher(entry);
  if (matcher === undefined) throw new Error('fixture entry is not a pattern');
  return matcher;
});

describe('who is an operator', () => {
  const addresses = new Map([
    ['owner', 'owner@example.com'],
    ['tester', 'cleo@test.knowscroll.space'],
    ['stranger', 'someone@example.com'],
  ]);
  const isOperator = makeIsOperator({ readAddress: (id) => Promise.resolve(addresses.get(id)), matchers });

  it('accepts an exact address and a pattern, and nobody else', async () => {
    expect(await isOperator('owner')).toBe(true);
    expect(await isOperator('tester')).toBe(true);
    expect(await isOperator('stranger')).toBe(false);
  });

  it('refuses an account that has no readable address, such as a deleted one', async () => {
    expect(await isOperator('gone')).toBe(false);
  });

  it('refuses everyone without reading an address when the world names no operator', async () => {
    let reads = 0;
    const nobody = makeIsOperator({
      readAddress: () => {
        reads += 1;
        return Promise.resolve('owner@example.com');
      },
      matchers: [],
    });
    expect(await nobody('owner')).toBe(false);
    expect(reads).toBe(0);
  });
});
