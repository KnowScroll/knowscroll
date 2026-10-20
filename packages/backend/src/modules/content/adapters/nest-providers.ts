import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeImportEditorialScroll } from '../application/import-editorial-scroll.js';
import {
  FIND_ASSET_FOR_ACTION,
  FIND_OPENABLE_ASSET,
  READ_SCROLL_READING_FACTS,
  RENDER_SCROLL,
  type FindAssetForAction,
  type FindOpenableAsset,
  type ReadScrollReadingFacts,
  type RenderScroll,
} from '../public.js';
import { makeRenderScroll } from './render-scroll.js';
import { compileEditorialSource, parseEditorialSource } from './scroll-compiler.js';
import { findAssetForAction, findOpenableAsset, makeAdmissionStore, readScrollReadingFacts } from './postgres-store.js';

/**
 * Reusable outer wiring (blueprint §22): content's scope-bound read ports, used inside a personal
 * transaction by experience and evidence. Composition roots only.
 */
export function contentProviders(): readonly (
  | { readonly provide: symbol; readonly useValue: FindAssetForAction }
  | { readonly provide: symbol; readonly useValue: FindOpenableAsset }
  | { readonly provide: symbol; readonly useValue: ReadScrollReadingFacts }
)[] {
  return [
    { provide: FIND_ASSET_FOR_ACTION, useValue: findAssetForAction },
    { provide: FIND_OPENABLE_ASSET, useValue: findOpenableAsset },
    { provide: READ_SCROLL_READING_FACTS, useValue: readScrollReadingFacts },
  ];
}

/** `renderScroll` for the API's composition root: reads the shared document outside any transaction. */
export function contentRenderProviders(tokens: { readonly database: symbol }) {
  return [
    {
      provide: RENDER_SCROLL,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>): RenderScroll => makeRenderScroll(db),
    },
  ];
}

/**
 * The operator command's use case (`dist/operator.js content import-editorial`): admits an authored
 * editorial Scroll over its own database handle. Re-exported by the API's `modules/content.ts`,
 * because only composition roots choose concrete implementations.
 */
export function importEditorialScrollUseCase(db: Kysely<Database>) {
  return makeImportEditorialScroll({
    parseSource: parseEditorialSource,
    compile: compileEditorialSource,
    ...makeAdmissionStore(db),
  });
}
