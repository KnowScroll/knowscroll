import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { explicitAskInput, exposureInput, historyClearInput, interactionInput, uuid, type ScrollAsset } from '../../../packages/contracts/src/index.ts';
import {
  pool,
  transaction,
  authenticateAndLock,
  ensureDevelopmentSession,
  clearScrollHistory,
  revokeSession,
  UnauthorizedSession,
  type AuthScope,
} from '../../../packages/db/src/index.ts';
import { compose } from '../../../packages/core/src/composer.ts';
import { ExplicitAskError, recordExplicitAsk } from '../../../packages/db/src/explicit-ask.ts';
import {listSavedTraces,readTraceRevisit,TraceRevisitError} from '../../../packages/db/src/trace-revisit.ts';

class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer (\S+)$/.exec(authorization ?? '');
  if (!match) throw new UnauthorizedSession();
  return match[1]!;
}

function emptyObject(value: unknown): value is Record<string, never> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

export function buildApp(developmentToken: string) {
  if (developmentToken.length < 24) throw new Error('KS_DEV_TOKEN must contain at least 24 characters');
  const app = Fastify({ logger: false, bodyLimit: 16384 });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof UnauthorizedSession) return reply.code(401).send({ error: 'Unauthorized' });
    const status = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500;
    const code = Number.isInteger(status) && status >= 400 && status < 500 ? status : 500;
    return reply.code(code).send({ error: code >= 500 ? 'Internal operation failed' : (error as Error).message });
  });

  app.addHook('onReady', async () => { await ensureDevelopmentSession(developmentToken); });

  const authenticated = <T>(
    authorization: string | undefined,
    fn: (scope: AuthScope, client: import('pg').PoolClient) => Promise<T>,
  ) => transaction(async client => {
    const scope = await authenticateAndLock(client, bearerToken(authorization));
    return fn(scope, client);
  });

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

  app.get('/v1/universe', async req => authenticated(req.headers.authorization, async (scope, client) => {
    const universe = (await client.query('SELECT revision, privacy_epoch FROM universe WHERE id=$1', [scope.universeId])).rows[0];
    const traces = await listSavedTraces(client,scope);
    return {
      universeId: scope.universeId,
      revision: universe.revision,
      privacyEpoch: universe.privacy_epoch,
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

  app.get('/v1/feed', async req => authenticated(req.headers.authorization, async (scope, client) => {
    const account = (await client.query('SELECT * FROM accounts WHERE universe_id=$1', [scope.universeId])).rows[0];
    const assets = (await client.query(`SELECT id AS "assetId", revision, kind, title, summary, body, source_title AS "sourceTitle", source_url AS "sourceUrl", truth_state AS "truthState" FROM asset WHERE kind='Scroll' ORDER BY editorial_order`)).rows as ScrollAsset[];
    const items = compose(assets, account.kept_asset_ids);
    const decisionId = randomUUID();
    await client.query('INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,$3,$4,$5,$6)', [decisionId, scope.universeId, account.revision, 'editorial-unkept-v1', JSON.stringify(items), scope.privacyEpoch]);
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
      return { exposureId, eventId };
    });
    return reply.code(201).send(result);
  });

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

  return app;
}
