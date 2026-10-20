import type { AssetKind, ProvenanceKind } from '../domain/provenance.js';
import type { ReadingFacts } from '../domain/reading-facts.js';

/** JSON the inventory stores as a document or provenance; opaque to the application layer. */
export type JsonObject = { readonly [key: string]: unknown };

declare const admissionBrand: unique symbol;

/**
 * The capability of one open admission transaction: the asset locked, the revision, its provenance
 * and the asset's current revision are written together or not at all. Only the adapter creates
 * it. Admission holds no personal root: content is shared, not personal.
 */
export interface AdmissionTx {
  readonly [admissionBrand]: true;
}

/** An asset as admission finds it under its lock. */
export type LockedAsset =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'present';
      readonly assetKind: AssetKind;
      readonly status: 'admitted' | 'withdrawn';
      /** The asset's current revision (>= 1). */
      readonly revision: number;
      /** `integrity.sha256` of the current revision's document, when it has a stored revision. */
      readonly documentSha256: string | undefined;
    };

/** A reason an editorial source could not be admitted, as a stable code and a path; never the text. */
export interface AdmissionIssue {
  readonly code: string;
  readonly path: string;
}

/** The result of compiling an editorial source at a given revision number. Pure and deterministic. */
export type CompileOutcome =
  | {
      readonly kind: 'compiled';
      /** The consumer document exactly as admission accepted it. */
      readonly document: JsonObject;
      /** The internal provenance: claims, sources, bindings, checks and the production record. */
      readonly provenance: JsonObject;
      readonly documentVersion: string;
      readonly provenanceVersion: string;
      /** `integrity.sha256` of the document. */
      readonly documentSha256: string;
      readonly explanationUnitId: string;
      readonly language: string;
      readonly title: string;
      readonly readingFacts: ReadingFacts;
    }
  | { readonly kind: 'refused'; readonly stage: string; readonly issues: readonly AdmissionIssue[] };

/** What a parsed editorial source file names before anything is compiled. */
export type SourceParse =
  | { readonly kind: 'source'; readonly assetId: string; readonly source: unknown }
  | { readonly kind: 'invalid'; readonly issues: readonly AdmissionIssue[] };

/** One admitted revision to store, with the asset's new current revision. */
export interface AdmittedRevision {
  readonly assetId: string;
  readonly revision: number;
  readonly provenanceKind: ProvenanceKind;
  readonly compiled: Extract<CompileOutcome, { kind: 'compiled' }>;
  /** True when the asset row does not exist yet (the first revision creates it). */
  readonly createsAsset: boolean;
}

/** Capabilities of `importEditorialScroll`. Adapters implement them; the composition root wires them. */
export interface ImportEditorialScrollPorts {
  /** Parses an editorial source file's envelope: its asset ID and everything `compile` needs. */
  readonly parseSource: (raw: unknown) => SourceParse;
  /** Compiles and admits the source as revision `revision` (scroll-model admission: every check, the integrity hash). */
  readonly compile: (source: unknown, revision: number) => CompileOutcome;
  /** Runs `work` in one transaction (admission is all or nothing). */
  readonly inAdmission: <T>(work: (tx: AdmissionTx) => Promise<T>) => Promise<T>;
  /** Serialises admissions of one asset, then reads its current state (no row may be missed or doubled). */
  readonly lockAsset: (tx: AdmissionTx, assetId: string) => Promise<LockedAsset>;
  readonly storeRevision: (tx: AdmissionTx, revision: AdmittedRevision) => Promise<void>;
}
