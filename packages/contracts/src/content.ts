/**
 * Public content schemas. The canonical Scroll document lives in `@knowscroll/scroll-model` and is
 * re-exported here, never copied (blueprint §6). Its internal provenance and producer contract are
 * backend-only and are not part of the wire contracts.
 *
 * `ClientCapabilities` is what a client says it can render when it opens an exposure
 * (`POST /v1/experience/open`); the server negotiates the document for it (D-012).
 */
export { ClientCapabilities, LocalId, SCROLL_DOCUMENT_SCHEMA_VERSION, ScrollDocument } from '@knowscroll/scroll-model';
