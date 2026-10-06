/** #201 — one web bundle serves every world; it learns which one from the address it is served on. */
import { describe, expect, it } from 'vitest';
import { worldFromHostname } from '../../src/world.ts';

describe('worldFromHostname', () => {
  it.each([
    ['app.knowscroll.space', 'live'],
    ['app.stage.knowscroll.space', 'stage'],
    ['app.dev.knowscroll.space', 'dev'],
    ['APP.DEV.KNOWSCROLL.SPACE', 'dev'],
    ['127.0.0.1', 'local'],
    ['localhost', 'local'],
    ['backend.dev.knowscroll.space', 'local'],
    ['app.dev.knowscroll.space.evil.example', 'local'],
  ] as const)('%s → %s', (hostname, world) => {
    expect(worldFromHostname(hostname)).toBe(world);
  });
});
