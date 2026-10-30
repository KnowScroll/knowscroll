import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReadContentSequence, ReadSeriesTotal, SequenceUnit } from '../public.js';

/** Most units one declared series can hold (`content.series_units.part` is 1 to 99). */
const MAX_UNITS = 99;

/** See `ReadSeriesTotal`: the count of the series revision's admitted units, read in the caller's transaction. */
export const readSeriesTotal: ReadSeriesTotal = async (scope, series) => {
  const row = await transactionOf(scope)
    .selectFrom('content.series_units')
    .select((builder) => builder.fn.countAll<string>().as('total'))
    .where('series_id', '=', series.seriesId)
    .where('series_revision', '=', series.seriesRevision)
    .executeTakeFirst();
  const total = Number(row?.total ?? 0);
  return total > 0 ? total : undefined;
};

const isFormat = (kind: string): kind is SequenceUnit['kind'] => kind === 'reel' || kind === 'scroll';

/**
 * See `ReadContentSequence`. A revision in no declared series is a sequence of one. When it is in
 * several, the latest series revision wins, then the smaller series id, so the answer is stable.
 */
export const readContentSequence: ReadContentSequence = async (scope, root) => {
  const trx = transactionOf(scope);
  const asset = await trx.selectFrom('content.assets').select('kind').where('id', '=', root.assetId).executeTakeFirst();
  if (asset === undefined || !isFormat(asset.kind)) return undefined;
  const membership = await trx
    .selectFrom('content.series_units')
    .select(['series_id', 'series_revision'])
    .where('asset_id', '=', root.assetId)
    .where('asset_revision', '=', root.assetRevision)
    .orderBy('series_revision', 'desc')
    .orderBy('series_id', 'asc')
    .executeTakeFirst();
  if (membership === undefined) return { kind: 'single', unit: { ...root, kind: asset.kind } };
  const units = await trx
    .selectFrom('content.series_units as unit')
    .innerJoin('content.assets as asset', 'asset.id', 'unit.asset_id')
    .select(['unit.part', 'unit.asset_id', 'unit.asset_revision', 'asset.kind'])
    .where('unit.series_id', '=', membership.series_id)
    .where('unit.series_revision', '=', membership.series_revision)
    .orderBy('unit.part', 'asc')
    .limit(MAX_UNITS)
    .execute();
  return {
    kind: 'series',
    seriesId: membership.series_id,
    seriesRevision: membership.series_revision,
    units: units.flatMap((unit) =>
      isFormat(unit.kind)
        ? [{ part: unit.part, assetId: unit.asset_id, assetRevision: unit.asset_revision, kind: unit.kind }]
        : [],
    ),
  };
};
