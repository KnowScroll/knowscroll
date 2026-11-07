import 'reflect-metadata';
import type { Provider } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { READ_SYSTEM_FINDS } from '@knowscroll/backend/modules/experience';
import { contentWiring } from './content.js';
import { evidenceWiring } from './evidence.js';
import { experienceWiring } from './experience.js';

const tokenOf = (provider: Provider) =>
  typeof provider === 'object' && 'provide' in provider ? provider.provide : provider;

describe('the API mounts every port a system’s Reels and Scrolls read needs (#697)', () => {
  it('provides each module port the READ_SYSTEM_FINDS provider injects', () => {
    const provider = experienceWiring.find((p) => tokenOf(p) === READ_SYSTEM_FINDS);
    if (!provider || typeof provider !== 'object' || !('inject' in provider) || !provider.inject)
      throw new Error('READ_SYSTEM_FINDS is not mounted with its injections');
    const provided = new Set([...contentWiring, ...evidenceWiring, ...experienceWiring].map(tokenOf));
    // The first two are the root's scope and account fence, provided by the app module itself.
    const ports = provider.inject.slice(2);
    expect(ports.length).toBeGreaterThan(0);
    expect(ports.filter((token) => !provided.has(token as never))).toEqual([]);
  });
});
