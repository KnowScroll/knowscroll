import type { CompileOutcome, SourceParse } from '../application/ports.js';
import { compileEditorialSource, parseEditorialSource } from './scroll-compiler.js';
import { compileEditorialSourceV3, EDITORIAL_SOURCE_V3_VERSION, parseEditorialSourceV3 } from './scroll-compiler-v3.js';

/** The source version a file says it is, read before its envelope is parsed. */
function versionOf(raw: unknown): unknown {
  return typeof raw === 'object' && raw !== null
    ? (raw as { readonly schemaVersion?: unknown }).schemaVersion
    : undefined;
}

/**
 * Parses an editorial source file of either version: `editorial-scroll-v3.v1` (a document v3) by its own envelope, any
 * other file as `editorial-scroll.v1`, whose envelope then reports what is wrong with it. Codes and paths only.
 */
export function parseEditorialSourceFile(raw: unknown): SourceParse {
  return versionOf(raw) === EDITORIAL_SOURCE_V3_VERSION ? parseEditorialSourceV3(raw) : parseEditorialSource(raw);
}

/** Compiles an editorial source of either version as revision `revision`. Pure and deterministic. */
export function compileEditorialSourceFile(source: unknown, revision: number): CompileOutcome {
  return versionOf(source) === EDITORIAL_SOURCE_V3_VERSION
    ? compileEditorialSourceV3(source, revision)
    : compileEditorialSource(source, revision);
}
