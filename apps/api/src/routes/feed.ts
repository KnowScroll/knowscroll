/**
 * `GET /v1/feed`: one composed decision over the candidate assets (ADR-0025, ADR-0032). `place`
 * (ADR-0051) narrows the candidates to one of the reader's live places and its regions, by the
 * Atlas's own membership rule, before the same Composer decides; the decision records that place.
 */

import {
  parseFeedKinds,
  parseFeedPlace,
} from '@knowscroll/contracts/inventory';
import type {
  COMPOSER_SEMANTIC_V3,
  COMPOSER_SEMANTIC_V4,
} from '@knowscroll/core/composer/semantic';
import { COMPOSER_SIGNALS_V2 } from '@knowscroll/core/composer/signals';
import { scopeToPlace } from '@knowscroll/db/atlas';
import { composeAndRecordV3 } from '@knowscroll/db/composer/semantic';
import { composeAndRecordV2 } from '@knowscroll/db/composer/signals';
import {
  feedCandidates,
  readFeedAccount,
  readFeedWebArtifacts,
} from '@knowscroll/db/feed';
import { observeExhaustion } from '@knowscroll/db/inventory/demand';
import type { FastifyInstance } from 'fastify';
import type { Authenticated } from '../http/authenticated.ts';
import { HttpError } from '../http/errors.ts';

export type ComposerPolicy =
  | typeof COMPOSER_SIGNALS_V2
  | typeof COMPOSER_SEMANTIC_V3
  | typeof COMPOSER_SEMANTIC_V4;

/** `exclude`: up to 256 comma-separated asset UUIDs, or absent. Null when malformed. */
function parseFeedExclude(value: unknown): Set<string> | null {
  if (value === undefined || value === '') return new Set();
  if (typeof value !== 'string') return null; // a repeated parameter arrives as an array: refuse it, never throw
  const ids = value.split(',');
  if (
    ids.length > 256 ||
    ids.some(
      (id) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        ),
    )
  )
    return null;
  return new Set(ids.map((id) => id.toLowerCase()));
}

export function registerFeedRoutes(
  app: FastifyInstance,
  authenticated: Authenticated,
  composerPolicy: ComposerPolicy,
): void {
  app.get<{
    Querystring: {
      kinds?: string;
      exclude?: string | string[];
      webArtifact?: string;
      preview?: string;
      place?: string | string[];
    };
  }>('/v1/feed', async (req) =>
    authenticated(req.headers.authorization, async (scope, client) => {
      const kinds = parseFeedKinds(req.query.kinds);
      if (kinds === null) throw new HttpError(400, 'Invalid kinds parameter');
      if (req.query.webArtifact !== undefined && req.query.webArtifact !== 'v1')
        throw new HttpError(400, 'Invalid webArtifact parameter');
      if (
        req.query.preview !== undefined &&
        req.query.preview !== 'authored-web-scrolls'
      )
        throw new HttpError(400, 'Invalid preview parameter');
      // Read at request time, not import time: the preview gate must follow the live environment.
      if (req.query.preview) {
        const databaseName = (() => {
          try {
            return new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
          } catch {
            return '';
          }
        })();
        if (
          process.env.NODE_ENV !== 'development' ||
          process.env.KS_RICH_SCROLL_PREVIEW !== '1' ||
          !/^knowscroll_(?:test|preview)_[a-z0-9_]+$/.test(databaseName)
        )
          throw new HttpError(400, 'Preview unavailable');
      }
      // What this discovery trip already has on screen or opened. The client skips those, so
      // offering them could end a trip while other Scrolls remain; v3 gates them with a named reason (#133).
      const exclude = parseFeedExclude(req.query.exclude);
      if (exclude === null)
        throw new HttpError(400, 'Invalid exclude parameter');
      const place = parseFeedPlace(req.query.place);
      if (place === null) throw new HttpError(400, 'Invalid place parameter');
      const account = await readFeedAccount(client, scope.universeId);
      const library = await feedCandidates(client, kinds);
      // ADR-0051: asked from a star or world, only what the Atlas counts there is a candidate, and an
      // empty place composes an empty slate, never filler. Anything but a live planet or region of
      // this universe is a 404.
      const scoped = place.placeId
        ? await scopeToPlace(client, scope.universeId, place.placeId, library)
        : null;
      const candidates = scoped?.assets ?? library;
      // Disposable preview only: authored examples go through the same composer, decision,
      // exposure and Keep path as any encounter; the ordinary feed is untouched.
      const assets = req.query.preview
        ? candidates.filter(
            (item) =>
              item.kind === 'Scroll' &&
              [
                'A rhythm the ocean keeps',
                'An orbit is not a perfect circle',
              ].includes(item.title),
          )
        : candidates;

      // The ranking policy is deployment configuration recorded on every decision: composer-semantic-v3
      // (ADR-0032) by default; composer-signals-v2 (ADR-0028/0029) and composer-semantic-v4 (v3 with a
      // fair tie-break, ADR-0043 §7) remain selectable and immutable.
      const { decisionId, items } =
        composerPolicy === COMPOSER_SIGNALS_V2
          ? await composeAndRecordV2(
              client,
              scope,
              assets,
              account,
              place.placeId,
            )
          : // v3 gates kept encounters itself and records them, so "why not that" has an answer.
            await composeAndRecordV3(
              client,
              scope,
              assets,
              account.revision,
              exclude,
              composerPolicy,
              place.placeId,
            );
      // ADR-0046 §1: a place this reader has now seen in full is a need, recorded with the semantic
      // decision that saw it; a scoped decision saw only its own place and the regions beneath it.
      if (composerPolicy !== COMPOSER_SIGNALS_V2)
        await observeExhaustion(
          client,
          scope,
          decisionId,
          scoped?.placeIds ?? null,
        );
      // Web-only representation: legacy and Android callers see the feed shape they already parse.
      // Re-read only the selected Scrolls after composition, so an invalid or stale artifact falls
      // back to the body without changing selection or exposure.
      const scrollIds =
        req.query.webArtifact === 'v1'
          ? items
              .filter((item) => item.kind === 'Scroll')
              .map((item) => item.assetId)
          : [];
      const artifacts = await readFeedWebArtifacts(client, scrollIds);
      const delivered =
        req.query.webArtifact === 'v1'
          ? items.map((item) => {
              const {
                sourceTitle: _sourceTitle,
                sourceUrl: _sourceUrl,
                ...readerItem
              } = item;
              return item.kind === 'Scroll'
                ? {
                    ...readerItem,
                    webArtifact: artifacts.get(item.assetId) ?? null,
                  }
                : readerItem;
            })
          : items;
      return {
        decisionId,
        universeId: scope.universeId,
        accountRevision: account.revision,
        privacyEpoch: scope.privacyEpoch,
        items: delivered,
      };
    }),
  );
}
