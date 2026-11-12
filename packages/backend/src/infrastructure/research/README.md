# Public research pages

Scroll production uses this adapter to turn an approved public page into bounded, inert source
passages before asking a model to write. The [production use case](../../modules/content/production/produce.ts)
and [writer spike](../../modules/content/production/spike-v2/run.ts) call
[fetchResearchPage](public-pages.ts); it must run outside a database transaction.

The URL policy allows only individually reviewed HTTPS hosts and paths. It rejects credentials,
query strings, fragments and non-default ports before DNS. Every redirect is checked again;
DNS answers must all be public addresses. A host on the list does not authorize fetching any
private address it resolves to. Code bounds redirects and response bytes, accepts supported
content types and extracts text without executing scripts.

For example, a URL with `?token=example` is refused as `url_parameters_refused`; it is not retried
with its parameters removed. `ResearchRefusal.code` explains the failure without logging source
text or credentials. Callers decide whether production can continue; a failed fetch is never
replaced with invented source material.

The returned page carries its policy version, URL, retrieval time, content hash and stable
passage identities. This is production source material, not personal encounter evidence. The
adapter has no tables, jobs or personal erasure store of its own.

The link reader (`extractResearchLinks`, `fetchResearchWithLinks`, #674, D-422) reads the links of a page's prose paragraphs, in order, for topic growth: the same body the passages
are read from (navigation, footer, reference lists and footnote markers are excluded), each link made absolute against the page, without its fragment or a trailing slash, and kept only
if the URL rule above allows it (a host that is not on the reviewed list, a credential, a port or a query makes it disappear), it names an article (on Wikipedia `/wiki/<Title>` with
no namespace, never the main page; any other host any path below its root) and it is not the page itself, at most 300. Nothing is fetched or executed by it; the fetch that returns the
links is the same fetch, with the same DNS, redirect and size checks, that returns the passages.

Run `pnpm --filter @knowscroll/backend exec vitest run src/infrastructure/research` from the root.
Authored network fixtures cover refused URLs and addresses, redirects, limits and extraction;
they make no live network calls and do not verify that an upstream page remains available.
