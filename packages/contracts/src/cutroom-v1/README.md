# Cutroom wire-schema snapshot

These seven pure Zod modules are copied byte-for-byte from KnowScroll/Cutroom at `238df85411108a94377311363dd296d785688f70`. [Source manifest](source.json) pins each upstream path and SHA-256. Original comments and imports are preserved. The shared wire version remains1 despite the required criterion-type amendment documented in KnowScroll issue#84.

Keep local HTTP status, identity, cursor and resource checks in the worker client. Do not silently change these wire definitions: a refresh requires a new pinned source comparison and review. No server, engine, provider, transport, filesystem import or publication capability is copied here. ADR0020 owns the client boundary.
