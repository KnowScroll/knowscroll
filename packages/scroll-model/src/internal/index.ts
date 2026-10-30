/**
 * `@knowscroll/scroll-model/internal`: backend-only provenance of a Scroll revision (claims,
 * sources, bindings, checks, production) and the honesty checks over it. Client packages must
 * never import this entry (dependency-cruiser `clients-never-import-scroll-internals`).
 */
export {
  CheckRecord,
  Claim,
  HEADER_FIELDS,
  ProductionRecord,
  ProvenanceBinding,
  SCROLL_PROVENANCE_SCHEMA_VERSION,
  ScrollProvenance,
  Source,
  TRUTH_STATES,
} from './provenance.js';
export { PROVENANCE_V2_LIMITS, SCROLL_PROVENANCE_V2_SCHEMA_VERSION, ScrollProvenanceV2 } from './provenance-v2.js';
export { bindingIssues, honestyIssues, STRUCTURAL_LITERALS, type HonestyDocument } from './honesty.js';
