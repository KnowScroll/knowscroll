import type { ClearCoreTx } from '../../modules/identity/public.js';
import {
  declaredStores,
  type ClearDisposition,
  type ErasureReport,
  type ModuleErasure,
  type ModuleExport,
} from './registry.js';

/** How selective Clear treats the declared stores, and the owner callback that does the erasing. */
export interface ClearDeclaration {
  /**
   * What Clear does with a declared store that `dispositions` does not name. Leave it out to force
   * an explicit answer for every store: start-up then refuses an unnamed one
   * (`CLEAR_DISPOSITION_MISSING`).
   */
  readonly defaultDisposition?: ClearDisposition;
  /** Per-store exceptions, keyed `schema.table` or `store:<name>`. */
  readonly dispositions?: Readonly<Record<string, ClearDisposition>>;
  readonly erase: (scope: ClearCoreTx) => Promise<ErasureReport>;
}

/** A module's erasure declaration as its author writes it: Clear and export beside the rest. */
export interface ErasureDeclaration extends Omit<ModuleErasure, 'clearExploration' | 'export'> {
  readonly clear: ClearDeclaration;
  /**
   * Builds the export from the finished declaration, so `exportReading` and `exportNothing` can
   * account for every store it declares.
   */
  readonly export: (declaration: ModuleErasure) => ModuleExport;
}

/**
 * Builds a module's `ModuleErasure` in one expression: the stores and erasers as written, the
 * selective-Clear dispositions derived from the declared stores plus the module's exceptions, and
 * the export built from the finished declaration. Nothing is assigned to the result afterwards.
 *
 * A store named in `clear.dispositions` that the module does not declare is kept, so the registry's
 * start-up check still refuses the mistake.
 */
export function declareErasure(declaration: ErasureDeclaration): ModuleErasure {
  const { clear, export: buildExport, ...stores } = declaration;
  const { defaultDisposition } = clear;
  const defaulted =
    defaultDisposition === undefined
      ? []
      : declaredStores(stores).map((name): [string, ClearDisposition] => [name, defaultDisposition]);
  const withClear: ModuleErasure = {
    ...stores,
    clearExploration: {
      dispositions: { ...Object.fromEntries(defaulted), ...clear.dispositions },
      erase: clear.erase,
    },
  };
  return { ...withClear, export: buildExport(withClear) };
}
