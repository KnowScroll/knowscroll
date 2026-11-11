import type { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import { checkLibrarySupportJob } from '../production/library-support-events.js';
import { LIBRARY_SUPPORT_CHECK_VERSION } from '../production/library-support.js';
import { makeEnqueueLibrarySupport } from './enqueue-library-support.js';

const ASSET = '8a7d48fe-0397-4e00-91a8-b4700630880f';

/** A labelled CI stand-in for pg-boss that records what is sent; `already` makes it answer as for a job that is queued or running. */
function fakeBoss(already: boolean) {
  const sent: { readonly name: string; readonly data: unknown; readonly options: unknown }[] = [];
  const boss = {
    send: (name: string, data: unknown, options: unknown) => {
      sent.push({ name, data, options });
      return Promise.resolve(already ? null : 'job-id');
    },
  } as unknown as PgBoss;
  return { sent, enqueue: makeEnqueueLibrarySupport(boss) };
}

describe('sending the support check of a held revision', () => {
  it('sends one job for the revision and checker version, under the key that keeps one in flight', async () => {
    const { sent, enqueue } = fakeBoss(false);
    expect(await enqueue(checkLibrarySupportJob(ASSET, 2))).toBe('queued');
    expect(sent).toEqual([
      {
        name: 'content.check-library-support',
        data: { v: 1, assetId: ASSET, revision: 2, checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION },
        options: { singletonKey: `${ASSET}:2:${LIBRARY_SUPPORT_CHECK_VERSION}` },
      },
    ]);
  });

  it('says so when a job for it is already queued or running', async () => {
    expect(await fakeBoss(true).enqueue(checkLibrarySupportJob(ASSET, 2))).toBe('already_queued');
  });

  it('refuses a payload the queue does not accept before anything is sent', async () => {
    const { sent, enqueue } = fakeBoss(false);
    await expect(enqueue({ ...checkLibrarySupportJob(ASSET, 2), revision: 0 })).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});
