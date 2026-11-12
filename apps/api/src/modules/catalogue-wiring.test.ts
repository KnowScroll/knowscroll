import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '@knowscroll/backend/modules/content';
import { DATABASE } from '../tokens.js';
import { contentWiring } from './content.js';

describe('the topic catalogue (D-419)', () => {
  it('is provided once to every module the API composes, over the process database', () => {
    const providers = contentWiring.filter(
      (provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === CATALOGUE,
    );
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ inject: [DATABASE] });
  });
});
