/**
 * Real reading through the API, as a device does it: the feed offers a Scroll, the reader is exposed
 * to it and may keep it. Every exposure and keep refreshes the personal model (ADR-0032), so the
 * attention, places and evidence that follow are the product's own, never supplied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { buildApp } from '../../apps/api/src/app.ts';
import { projectOne } from '../../apps/worker/src/project.ts';
import { pool } from '../../packages/db/src/index.ts';

/** Asks the feed for more, skipping what this trip already saw, until the target is offered; exposes
 * only it, and keeps it when asked (its projection job runs at once). The library bounds the trip:
 * a feed with nothing new left to offer ends it. */
export async function readScroll(app: ReturnType<typeof buildApp>, headers: Record<string, string>, assetId: string, keep: boolean): Promise<void> {
  const skipped: string[] = [];
  for (;;) {
    const response = await app.inject({ url: `/v1/feed?kinds=Scroll${skipped.length ? `&exclude=${skipped.join(',')}` : ''}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    const feed = response.json() as { decisionId: string; items: { assetId: string }[] };
    if (feed.items.length === 0) throw new Error(`The feed never offered ${assetId}`);
    if (!feed.items.some(x => x.assetId === assetId)) { skipped.push(...feed.items.map(x => x.assetId)); continue; }
    const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers, payload: { decisionId: feed.decisionId, assetId, clientExposureId: randomUUID() } });
    assert.equal(exposure.statusCode, 201, exposure.body);
    if (!keep) return;
    const kept = await app.inject({ method: 'POST', url: '/v1/interactions', headers, payload: { clientEventId: randomUUID(), exposureId: exposure.json().exposureId, assetId, kind: 'keep' } });
    assert.equal(kept.statusCode, 202, kept.body);
    await pool.query("UPDATE job SET available_at='1990-01-01T00:00:00Z' WHERE id=$1", [kept.json().jobId]);
    assert.equal((await projectOne())?.status, 'completed');
    return;
  }
}

/** Reads whatever the feed offers first: any new exposure refreshes the personal model and the atlas. */
export async function readFirstOffered(app: ReturnType<typeof buildApp>, headers: Record<string, string>): Promise<void> {
  const feed = (await app.inject({ url: '/v1/feed?kinds=Scroll', headers })).json();
  const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers, payload: { decisionId: feed.decisionId, assetId: feed.items[0].assetId, clientExposureId: randomUUID() } });
  assert.equal(exposure.statusCode, 201, exposure.body);
}
