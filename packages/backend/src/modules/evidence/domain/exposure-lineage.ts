/**
 * An exposure as evidence needs it to validate an observation's lineage: which revision it presents
 * and whether, and when, its article became the active reading surface. A structural copy of what
 * experience's public read port provides, so this module never imports experience's surface (and
 * experience's imports of evidence never form a cycle).
 */
export interface ExposureLineage {
  readonly id: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly openedAt: Date;
  /** Undefined until activation: observations are accepted only for an activated exposure. */
  readonly activatedAt: Date | undefined;
  readonly privacyEpoch: number;
}
