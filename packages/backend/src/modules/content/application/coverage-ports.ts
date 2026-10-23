import type { PersonalScopeTx } from '../../identity/public.js';
import type { AdmissionTx } from './ports.js';
import type {
  CoverageAuthority,
  CoverageCatalogue,
  CoverageCommand,
  CoverageMapping,
  CoverageRef,
  CoverageTarget,
} from '../domain/coverage.js';

export interface CoverageHead {
  readonly authority: CoverageAuthority;
  readonly status: 'active' | 'retracted';
  readonly mapping: CoverageMapping;
  readonly commandSha256: string;
  readonly semanticReviewReference: string;
}
export type CoverageRead =
  | { readonly kind: 'unavailable' | 'unmapped' }
  | { readonly kind: 'retracted'; readonly authority: CoverageAuthority }
  | { readonly kind: 'mapped'; readonly head: CoverageHead };
export type ReadAdmittedCoverageMapping = (scope: PersonalScopeTx, ref: CoverageRef) => Promise<CoverageRead>;
/** Holds current asset/head SHARE locks until the caller's personal transaction ends. */
export type LockCurrentCoverageAuthorities = (
  scope: PersonalScopeTx,
  expected: readonly CoverageAuthority[],
) => Promise<boolean>;
export type AdmitCoverage = (input: CoverageCommand) => Promise<CoverageHead>;
/** Reads and writes of one exact asset revision's coverage head inside an admission transaction. */
export interface CoverageHeadPorts {
  readonly hash: (value: unknown) => string;
  readonly bytes: (value: unknown) => number;
  readonly catalogue: CoverageCatalogue;
  /** Locks the asset revision's coverage, then reads the stored target it would describe. */
  readonly lockTarget: (tx: AdmissionTx, ref: CoverageRef) => Promise<CoverageTarget | undefined>;
  readonly readHead: (tx: AdmissionTx, ref: CoverageRef) => Promise<CoverageHead | undefined>;
  readonly append: (tx: AdmissionTx, command: CoverageCommand, head: CoverageHead) => Promise<void>;
}
/** Only a trusted composition constructs these ports. A caller's string is never approval. */
export interface CoverageAdmissionPorts extends CoverageHeadPorts {
  readonly reviewed: (commandSha256: string, semanticReviewReference: string) => boolean;
  readonly inAdmission: <T>(work: (tx: AdmissionTx) => Promise<T>) => Promise<T>;
}
