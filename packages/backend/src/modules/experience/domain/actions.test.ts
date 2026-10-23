import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { decideActionEffect, type ActionKind } from './actions.js';

const kinds = fc.constantFrom<ActionKind>('save', 'unsave');

describe('decideActionEffect', () => {
  test.prop([fc.boolean(), kinds])('the resulting state depends only on the action', (saved, kind) => {
    expect(decideActionEffect({ saved }, kind).saved).toBe(kind === 'save');
  });

  test.prop([fc.boolean(), kinds])('changed is true exactly when the state flips', (saved, kind) => {
    const effect = decideActionEffect({ saved }, kind);
    expect(effect.changed).toBe(effect.saved !== saved);
  });

  test.prop([fc.boolean(), kinds])('applying the same action twice changes nothing the second time', (saved, kind) => {
    const first = decideActionEffect({ saved }, kind);
    expect(decideActionEffect({ saved: first.saved }, kind)).toEqual({ saved: first.saved, changed: false });
  });
});
