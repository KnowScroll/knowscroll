/**
 * `@knowscroll/scroll-model/admission`: ADMISSION, for the server, the worker and tooling only.
 * Everything here runs the full-grid finiteness proof of each simulation (up to 10,000 points,
 * milliseconds on a JIT and tens to hundreds on Hermes) and computes and compares its display
 * scale. A device must not import this entry: dependency-cruiser refuses it
 * (`clients-never-import-scroll-admission`), and the client's own entry point has the cheap
 * counterparts, `parseDocument` and `parseBlock`.
 *
 * The same functions are still exported from the public entry for compatibility with code written
 * before this entry existed; ESLint refuses their import from client code
 * (`no-restricted-imports` on the client packages). New server code imports them from here.
 */
export {
  admitBlock,
  admitDocument,
  validateDocument,
  type DocumentOutcome,
  type ValidateOptions,
} from '../validate.js';
