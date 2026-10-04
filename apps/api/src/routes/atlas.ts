/**
 * The reader's places (ADR-0036; #134).
 *
 * Every read carries `Cache-Control: no-store`. `?webReader=v1` is the only accepted query and
 * selects the reader projection, which drops source titles and source families; any other query is
 * refused with 400 before the atlas is read.
 *
 *   GET  /v1/atlas                          live places, typed relations between them, chronicle
 *   GET  /v1/atlas/deltas/:deltaId          one change and its evidence
 *   POST /v1/atlas/places/:placeId/reject   the reader sets a planet or region aside
 */

import { uuid } from '@knowscroll/contracts';
import {
  type AtlasView,
  readAtlas,
  readAtlasDelta,
  rejectPlace,
} from '@knowscroll/db/atlas';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Authenticated } from '../http/authenticated.ts';
import { HttpError } from '../http/errors.ts';
import { noStore, requireUuid } from '../http/input.ts';

const rejectInput = z
  .object({ expectedPrivacyEpoch: z.number().int().min(0).max(2147483647) })
  .strict();

function readerAtlas(atlas: AtlasView) {
  const claim = (value: { text: string; sourceTitle: string } | null) =>
    value ? { text: value.text } : null;
  return {
    ...atlas,
    places: atlas.places.map((place) => ({
      ...place,
      basis: place.basis
        ? { ...place.basis, claim: claim(place.basis.claim) }
        : null,
      attention: place.attention
        ? (({ sourceFamilies: _sourceFamilies, ...attention }) => attention)(
            place.attention,
          )
        : null,
      foundation: place.foundation
        ? {
            ...place.foundation,
            relations: place.foundation.relations.map((relation) => ({
              ...relation,
              claim: claim(relation.claim),
            })),
          }
        : null,
    })),
    relations: atlas.relations.map((relation) => ({
      ...relation,
      claim: claim(relation.claim),
    })),
  };
}

function readerQuery(value: Record<string, unknown>): boolean {
  if (Object.keys(value).length === 0) return false;
  if (Object.keys(value).length === 1 && value.webReader === 'v1') return true;
  throw new HttpError(400, 'Invalid Atlas request');
}

export function registerAtlasRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
): void {
  app.get<{ Querystring: { webReader?: string } }>(
    '/v1/atlas',
    async (req, reply) => {
      const result = await authenticated(
        req.headers.authorization,
        async (scope, client) => ({
          webReader: readerQuery(req.query),
          atlas: await readAtlas(client, scope.universeId),
        }),
      );
      return noStore(reply).send(
        result.webReader ? readerAtlas(result.atlas) : result.atlas,
      );
    },
  );

  app.get<{ Params: { deltaId: string } }>(
    '/v1/atlas/deltas/:deltaId',
    async (req, reply) => {
      const delta = await authenticated(
        req.headers.authorization,
        async (scope, client) => {
          requireUuid(req.params.deltaId, 'Invalid delta id');
          return readAtlasDelta(client, scope.universeId, req.params.deltaId);
        },
      );
      return noStore(reply).send(delta);
    },
  );

  app.post<{
    Params: { placeId: string };
    Querystring: { webReader?: string };
  }>('/v1/atlas/places/:placeId/reject', async (req, reply) => {
    const result = await authenticated(
      req.headers.authorization,
      async (scope, client) => {
        const parsed = rejectInput.safeParse(req.body);
        const webReader = readerQuery(req.query);
        if (!uuid.safeParse(req.params.placeId).success || !parsed.success)
          throw new HttpError(400, 'Invalid reject request');
        if (parsed.data.expectedPrivacyEpoch !== scope.privacyEpoch)
          throw new HttpError(409, 'Privacy epoch changed');
        await rejectPlace(client, scope.universeId, req.params.placeId);
        return { webReader, atlas: await readAtlas(client, scope.universeId) };
      },
    );
    return noStore(reply).send(
      result.webReader ? readerAtlas(result.atlas) : result.atlas,
    );
  });
}
