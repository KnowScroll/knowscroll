import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { explicitAskInput, exposureInput, historyClearInput, interactionInput, privacyLifecycleInput, privacyResetInput, uuid, type ScrollAsset } from '../../../packages/contracts/src/index.ts';
import { parseFeedKinds, type FeedAsset, type ReelAssetDisplay } from '../../../packages/contracts/src/inventory.ts';
import {
  pool,
  transaction,
  authenticateAndLock,
  ensureDevelopmentSession,
  clearScrollHistory,
  pauseRecording,
  resumeRecording,
  exportUniverse,
  resetPersonalUniverse,
  revokeSession,
  UnauthorizedSession,
  type AuthScope,
} from '../../../packages/db/src/index.ts';
import { COMPOSER_SIGNALS_V2, rankSignalCandidates } from '../../../packages/core/src/composer.ts';
import { loadComposerExplanationTemplates, loadComposerPolicy, loadComposerSignalCandidates } from '../../../packages/db/src/composer-signals.ts';
import { ExplicitAskError, recordExplicitAsk } from '../../../packages/db/src/explicit-ask.ts';
import {listSavedTraces,readTraceRevisit,TraceRevisitError} from '../../../packages/db/src/trace-revisit.ts';
import { SHARED_SOURCE_V1, projectWorldsForEncounter, readWorldSystem } from '../../../packages/db/src/worlds.ts';
import { HttpError } from './errors.ts';
import { MEDIA_SHA256_PATTERN, resolveMediaRoot, sendMedia } from './media.ts';
import { registerSignInRoutes } from './sign-in-routes.ts';
import { registerSemanticRoutes } from './semantic-routes.ts';
import type { MagicLinkRateLimits } from '../../../packages/db/src/sign-in.ts';

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer (\S+)$/.exec(authorization ?? '');
  if (!match) throw new UnauthorizedSession();
  return match[1]!;
}

function emptyObject(value: unknown): value is Record<string, never> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

interface ReelRow {
  assetId: string; revision: number; title: string; summary: string; truthState: string;
  simulated: boolean; mediaSha256: string; sourceTitle: string; sourceUrl: string; probe: unknown;
}

/** ADR-0025 section 2: only ever built from a stored ffprobe `probe` and the KnowScroll-owned
 * content-addressed media route — the engine's own file path is never sent. */
function toReelAsset(row: ReelRow): ReelAssetDisplay {
  const probe = row.probe as { durationSeconds?: unknown; width?: unknown; height?: unknown } | null;
  const durationSeconds = typeof probe?.durationSeconds === 'number' ? probe.durationSeconds : 0;
  const width = typeof probe?.width === 'number' ? probe.width : 0;
  const height = typeof probe?.height === 'number' ? probe.height : 0;
  return {
    assetId: row.assetId, revision: row.revision, kind: 'Reel', title: row.title, summary: row.summary,
    truthState: 'synthesis', generatedLabel: true, simulated: row.simulated,
    mediaUrl: `/v1/media/${row.mediaSha256}`, durationSeconds, aspect: `${width}:${height}`,
    sourceTitle: row.sourceTitle, sourceUrl: row.sourceUrl,
  };
}

/**
 * ADR-0025 section 2: candidates for `GET /v1/feed`. The default (`kinds` absent, or explicitly
 * `Scroll` alone) queries and returns EXACTLY what this route has always returned — the Reel query
 * never even runs — so an existing client sees no change at all. When `Reel` is requested, eligible/
 * test_eligible non-withdrawn Reel assets are interleaved (Scroll, Reel, Scroll, Reel, …) with the
 * Scroll list before `compose()`'s own bound/kept-filter runs, so a bounded few candidates are not
 * permanently dominated by whichever kind currently has more rows; this is still no inference and
 * no engagement signal, only a fixed, documented merge order.
 */
async function feedCandidates(client: import('pg').PoolClient, kinds: readonly ('Scroll' | 'Reel')[]): Promise<FeedAsset[]> {
  const scrolls = kinds.includes('Scroll') ? (await client.query(
    `SELECT id AS "assetId", revision, kind, title, summary, body, source_title AS "sourceTitle", source_url AS "sourceUrl", truth_state AS "truthState"
     FROM asset WHERE kind='Scroll' ORDER BY editorial_order`,
  )).rows as ScrollAsset[] : [];
  if (!kinds.includes('Reel')) return scrolls;
  const reelRows = (await client.query<ReelRow>(
    `SELECT a.id AS "assetId", a.revision, a.title, a.summary, a.truth_state AS "truthState", a.simulated,
            a.media_sha256 AS "mediaSha256", a.source_title AS "sourceTitle", a.source_url AS "sourceUrl", m.probe AS probe
     FROM asset a
     JOIN generated_reel g ON g.id = a.generated_reel_id
     JOIN media_object m ON m.sha256 = a.media_sha256
     WHERE a.kind='Reel' AND a.withdrawn_at IS NULL AND g.availability IN ('eligible','test_eligible')
     ORDER BY g.created_at, a.id`,
  )).rows;
  const reels = reelRows.map(toReelAsset);
  const merged: FeedAsset[] = [];
  for (let i = 0; i < Math.max(scrolls.length, reels.length); i += 1) {
    if (scrolls[i]) merged.push(scrolls[i]!);
    if (reels[i]) merged.push(reels[i]!);
  }
  return merged;
}

export function buildApp(developmentToken: string, options: { mediaRoot?: string; magicLinkLimits?: MagicLinkRateLimits } = {}) {
  if (developmentToken.length < 24) throw new Error('KS_DEV_TOKEN must contain at least 24 characters');
  // Resolved once at build time (deployment configuration, never per-request data), but only
  // actually required the first time the media route is hit: a caller that never touches
  // /v1/media/:sha256 (most existing tests) never needs KS_MEDIA_ROOT/KS_DEV_ROOT set.
  let mediaRoot: string | undefined = options.mediaRoot;
  const resolvedMediaRoot = () => mediaRoot ?? (mediaRoot = resolveMediaRoot());
  const app = Fastify({ logger: false, bodyLimit: 16384 });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof UnauthorizedSession) return reply.code(401).send({ error: 'Unauthorized' });
    const status = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500;
    const code = Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
    return reply.code(code).send({ error: code >= 500 ? 'Internal operation failed' : (error as Error).message });
  });

  app.addHook('onReady', async () => { await ensureDevelopmentSession(developmentToken); });

  // ADR-0026: real sign-in (magic link, single owner account). Additive — every route above and
  // below is unchanged, and a session this mints authenticates through the exact same
  // `authenticateAndLock` path as a development-token session.
  registerSignInRoutes(app, options.magicLinkLimits);

  const authenticated = <T>(
    authorization: string | undefined,
    fn: (scope: AuthScope, client: import('pg').PoolClient) => Promise<T>,
  ) => transaction(async client => {
    const scope = await authenticateAndLock(client, bearerToken(authorization));
    return fn(scope, client);
  });

  // #131: semantic continuations and connection feedback, through the same authenticated path.
  registerSemanticRoutes(app, authenticated);

  app.get('/health', async () => { await pool.query('SELECT 1'); return { status: 'ok', database: true }; });

  app.get('/v1/session', async req => authenticated(req.headers.authorization, async scope => scope));

  app.post('/v1/session/revoke', async (req, reply) => {
    await authenticated(req.headers.authorization, async (scope, client) => {
      if (!emptyObject(req.body)) throw new HttpError(400, 'Invalid revoke request');
      await revokeSession(client, scope);
    });
    return reply.code(204).send();
  });

  app.post('/v1/history/clear', async (req, reply) => {
    const receipt = await authenticated(req.headers.authorization, async (scope, client) => {
      const parsed = historyClearInput.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid history clear request');
      return clearScrollHistory(client, scope, parsed.data);
    });
    return reply.code(200).send(receipt);
  });

  // ADR-0028: privacy lifecycle. Pause/resume/export/reset all go through the same
  // `authenticated()` path as every other route above, so the universe lock is held and the
  // session's epoch is rechecked before any of them runs a single statement.
  app.post('/v1/privacy/pause', async (req, reply) => {
    const receipt = await authenticated(req.headers.authorization, async (scope, client) => {
      const parsed = privacyLifecycleInput.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid pause request');
      return pauseRecording(client, scope, parsed.data);
    });
    return reply.code(200).send(receipt);
  });

  app.post('/v1/privacy/resume', async (req, reply) => {
    const receipt = await authenticated(req.headers.authorization, async (scope, client) => {
      const parsed = privacyLifecycleInput.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid resume request');
      return resumeRecording(client, scope, parsed.data);
    });
    return reply.code(200).send(receipt);
  });

  app.post('/v1/privacy/export', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, async (scope, client) => {
      const parsed = privacyLifecycleInput.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid export request');
      return exportUniverse(client, scope, parsed.data);
    });
    return reply.code(200).send(result);
  });

  app.post('/v1/privacy/reset', async (req, reply) => {
    const receipt = await authenticated(req.headers.authorization, async (scope, client) => {
      const parsed = privacyResetInput.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid reset request');
      return resetPersonalUniverse(client, scope, parsed.data);
    });
    return reply.code(200).send(receipt);
  });

  app.get('/v1/universe', async req => authenticated(req.headers.authorization, async (scope, client) => {
    const universe = (await client.query('SELECT revision, privacy_epoch, recording_paused_at FROM universe WHERE id=$1', [scope.universeId])).rows[0];
    const traces = await listSavedTraces(client,scope);
    return {
      universeId: scope.universeId,
      revision: universe.revision,
      privacyEpoch: universe.privacy_epoch,
      recordingPausedAt: universe.recording_paused_at ? new Date(universe.recording_paused_at).toISOString() : null,
      traces,
      capabilities: { reasoning: false, reels: false, worldEvolution: false },
    };
  }));

  app.get<{Params:{eventId:string}}>('/v1/traces/:eventId',async (req,reply)=>{
    const result=await authenticated(req.headers.authorization,async(scope,client)=>{
      if(req.body!==undefined||Object.keys(req.query as object).length>0
        ||Number(req.headers['content-length']??0)>0||req.headers['transfer-encoding']!==undefined) {
        throw new HttpError(400,'Invalid Trace request');
      }
      try {return await readTraceRevisit(client,scope,req.params.eventId);}
      catch(error) {
        if(!(error instanceof TraceRevisitError)) throw error;
        if(error.kind==='invalid') throw new HttpError(400,'Invalid Trace event ID');
        if(error.kind==='not_found') throw new HttpError(404,'Trace not found');
        if(error.kind==='stale_epoch') throw new HttpError(409,'Trace privacy epoch is stale');
        if(error.kind==='source_changed') throw new HttpError(409,'Saved Scroll source is unavailable');
        throw new HttpError(422,'Saved Scroll lineage is unavailable');
      }
    });
    return reply.header('Cache-Control','no-store').send(result);
  });

  app.get<{ Querystring: { kinds?: string } }>('/v1/feed', async req => authenticated(req.headers.authorization, async (scope, client) => {
    const kinds = parseFeedKinds(req.query.kinds);
    if (kinds === null) throw new HttpError(400, 'Invalid kinds parameter');
    const account = (await client.query('SELECT * FROM accounts WHERE universe_id=$1', [scope.universeId])).rows[0];
    const assets = await feedCandidates(client, kinds);

    // ADR-0028 (#114/#5): real retrieval-time signals, a versioned policy and a registered
    // explanation vocabulary, all fetched with bounded SQL — never a provider call
    // (packages/core/AGENTS.md, ADR-0016). `policy_version` stays 'editorial-unkept-v1' (section 1:
    // retrieval itself is unchanged); `ranking_version` records the policy that actually ordered
    // and explained this slate, so migration 0017's own invariants apply to every decision from
    // here on. composer-signals-v2 (#113/ADR-0029 amendment, migration 0021): adds a coverage
    // tie-break over v1's hash-only one so a source cannot sit behind another indefinitely;
    // composer-signals-v1 stays registered but is never loaded by any code path from here on.
    const policy = await loadComposerPolicy(client, COMPOSER_SIGNALS_V2);
    const templates = await loadComposerExplanationTemplates(client);
    const { candidates, nowMs } = await loadComposerSignalCandidates(client, scope.universeId, assets);
    const ranked = rankSignalCandidates(candidates, account.kept_asset_ids, policy, templates, nowMs);
    const items = ranked.map(r => r.item);

    const decisionId = randomUUID();
    await client.query(
      'INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch,ranking_version) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [decisionId, scope.universeId, account.revision, 'editorial-unkept-v1', JSON.stringify(items), scope.privacyEpoch, policy.version],
    );
    for (const r of ranked) {
      await client.query(
        `INSERT INTO decision_signal(id,decision_id,universe_id,asset_id,rank,retrieval_score,inputs,explanation_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), decisionId, scope.universeId, r.item.assetId, r.rank, r.retrievalScore, JSON.stringify(r.inputs), r.explanationKey],
      );
    }
    return { decisionId, universeId: scope.universeId, accountRevision: account.revision, privacyEpoch: scope.privacyEpoch, items };
  }));

  app.post('/v1/exposures', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, async (scope, client) => {
      const parsed = exposureInput.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid exposure');
      const body = parsed.data;
      const decision = (await client.query('SELECT candidates, privacy_epoch FROM decision WHERE id=$1 AND universe_id=$2', [body.decisionId, scope.universeId])).rows[0];
      if (!decision) throw new HttpError(422, 'Asset was not selected in this decision');
      if (decision.privacy_epoch !== scope.privacyEpoch) throw new HttpError(409, 'Decision belongs to an older privacy epoch');
      const old = (await client.query('SELECT * FROM exposure WHERE universe_id=$1 AND client_key=$2', [scope.universeId, body.clientExposureId])).rows[0];
      if (old) {
        if (old.decision_id !== body.decisionId || old.asset_id !== body.assetId) throw new HttpError(409, 'Exposure key reused with different content');
        return { exposureId: old.id, eventId: old.event_id };
      }
      if (!decision.candidates.some((asset: ScrollAsset) => asset.assetId === body.assetId)) throw new HttpError(422, 'Asset was not selected in this decision');
      const exposureId = randomUUID();
      const eventId = randomUUID();
      await client.query('INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch) VALUES($1,$2,$3,$4,$5,$6)', [eventId, scope.universeId, 'exposure', body.clientExposureId, JSON.stringify({ ...body, exposureId }), scope.privacyEpoch]);
      await client.query('INSERT INTO exposure(id,universe_id,decision_id,asset_id,event_id,client_key) VALUES($1,$2,$3,$4,$5,$6)', [exposureId, scope.universeId, body.decisionId, body.assetId, eventId, body.clientExposureId]);
      // ADR-0028: a reader encountering more is exactly what keeps their world/system current.
      // Runs inside this same transaction, under the universe lock `authenticateAndLock` already
      // holds -- a brand-new exposure is the only new evidence this endpoint can produce, and this
      // is the one deterministic projection step that must never lag behind it.
      await projectWorldsForEncounter(client, scope.universeId);
      return { exposureId, eventId };
    });
    return reply.code(201).send(result);
  });

  app.get('/v1/worlds', async req => authenticated(req.headers.authorization, async (scope, client) => {
    const system = await readWorldSystem(client, scope.universeId);
    return { derivationMethod: SHARED_SOURCE_V1, system };
  }));

  app.post('/v1/interactions', async (req, reply) => {
    const result = await authenticated(req.headers.authorization, async (scope, client) => {
      const parsed = interactionInput.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid interaction');
      const body = parsed.data;
      const exposure = (await client.query(`SELECT e.event_id, e.asset_id, l.privacy_epoch
        FROM exposure e JOIN ledger l ON l.id=e.event_id WHERE e.id=$1 AND e.universe_id=$2`, [body.exposureId, scope.universeId])).rows[0];
      if (!exposure) throw new HttpError(422, 'A matching exposure is required');
      if (exposure.privacy_epoch !== scope.privacyEpoch) throw new HttpError(409, 'Exposure belongs to an older privacy epoch');
      const old = (await client.query(`SELECT l.id,l.payload,j.id AS job_id FROM ledger l JOIN job j ON j.event_id=l.id WHERE l.universe_id=$1 AND l.kind='keep' AND l.client_key=$2`, [scope.universeId, body.clientEventId])).rows[0];
      if (old) {
        if (old.payload.exposureId !== body.exposureId || old.payload.assetId !== body.assetId) throw new HttpError(409, 'Event key reused with different content');
        return { eventId: old.id, jobId: old.job_id, status: 'accepted' };
      }
      if (exposure.asset_id !== body.assetId) throw new HttpError(422, 'A matching exposure is required');
      const eventId = randomUUID();
      const jobId = randomUUID();
      await client.query('INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch) VALUES($1,$2,$3,$4,$5,$6,$7)', [eventId, scope.universeId, 'keep', body.clientEventId, exposure.event_id, JSON.stringify(body), scope.privacyEpoch]);
      await client.query('INSERT INTO job(id,universe_id,event_id,kind,privacy_epoch) VALUES($1,$2,$3,$4,$5)', [jobId, scope.universeId, eventId, 'project_keep', scope.privacyEpoch]);
      return { eventId, jobId, status: 'accepted' };
    });
    return reply.code(202).send(result);
  });

  app.post('/v1/asks', { bodyLimit: 32768 }, async (req, reply) => {
    const result = await authenticated(req.headers.authorization, async (scope, client) => {
      const parsed = explicitAskInput.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid Ask');
      try {
        return await recordExplicitAsk(client, scope, parsed.data);
      } catch (error) {
        if (!(error instanceof ExplicitAskError)) throw error;
        if (error.kind === 'invalid') throw new HttpError(400, 'Invalid Ask');
        if (error.kind === 'stale_epoch') throw new HttpError(409, 'Ask privacy epoch is stale');
        if (error.kind === 'conflict') throw new HttpError(409, 'Ask conflicts with existing request');
        throw new HttpError(422, 'A current matching exposure is required');
      }
    });
    return reply.code(201).send(result);
  });

  app.get<{ Params: { eventId: string } }>('/v1/events/:eventId', async req => {
    return authenticated(req.headers.authorization, async (scope, client) => {
      if (!uuid.safeParse(req.params.eventId).success) throw new HttpError(400, 'Invalid event ID');
      const row = (await client.query(`SELECT l.id AS "eventId", l.causation_id AS "causationId", l.payload->>'exposureId' AS "exposureId", l.kind, j.id AS "jobId", j.status AS "jobStatus", COALESCE(j.status='completed',false) AS projected FROM ledger l LEFT JOIN job j ON j.event_id=l.id WHERE l.id=$1 AND l.universe_id=$2`, [req.params.eventId, scope.universeId])).rows[0];
      if (!row) throw new HttpError(404, 'Event not found');
      return row;
    });
  });

  // ADR-0024 section 4: content-addressed, authenticated media serving. The sha256 path parameter
  // is validated before anything else touches it; authorization (session, epoch, and an eligible
  // or test_eligible generated_reel naming this media) happens in ONE short transaction; bytes are
  // streamed by sendMedia() entirely OUTSIDE that transaction, which has already committed by the
  // time this handler calls it.
  app.route<{ Params: { sha256: string } }>({
    method: ['GET', 'HEAD'],
    url: '/v1/media/:sha256',
    handler: async (req, reply) => {
      const sha256 = req.params.sha256;
      if (!MEDIA_SHA256_PATTERN.test(sha256)) throw new HttpError(400, 'Invalid media identifier');
      const authorized = await authenticated(req.headers.authorization, async (_scope, client) => {
        // Content-addressed media can in principle be shared by more than one generated_reel row
        // (the same bytes imported twice). If ANY of them is a genuine 'eligible' reference, this
        // never reports the simulated marker for that content — a real Reel's bytes are never
        // mislabelled as stand-in just because some other row also names them 'test_eligible'.
        const row = (await client.query<{ storage_key: string; simulated: boolean }>(
          `SELECT m.storage_key, (g.availability = 'test_eligible') AS simulated
           FROM generated_reel g JOIN media_object m ON m.sha256 = g.media_sha256
           WHERE g.media_sha256 = $1 AND g.availability IN ('eligible','test_eligible')
           ORDER BY (g.availability = 'eligible') DESC, g.created_at ASC LIMIT 1`,
          [sha256],
        )).rows[0];
        return row ? { storageKey: row.storage_key, simulated: row.simulated } : null;
      });
      // Unknown, ineligible and (below, inside sendMedia) missing-on-disk all return the same 404:
      // this never tells a caller which of those was true.
      if (!authorized) throw new HttpError(404, 'Media not found');
      return sendMedia(req, reply, resolvedMediaRoot(), authorized);
    },
  });

  return app;
}
