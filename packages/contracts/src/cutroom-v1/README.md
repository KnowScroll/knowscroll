# Cutroom wire-schema snapshot

These seven pure Zod modules are copied byte-for-byte from KnowScroll/Cutroom at `86d6e2c8b74228db4a5a953e53c53a7b77cef46e` (successor pin, #89/ADR-0021; previously `238df854`). Only `record.ts` changed between those pins: `RunRecord` now requires a `takes` array within wire version1, so a record without it is rejected rather than tolerated. [Source manifest](source.json) pins each upstream path and SHA-256. Original comments and imports are preserved. The shared wire version remains1 despite the required criterion-type amendment documented in KnowScroll issue#84.

Keep local HTTP status, identity, cursor and resource checks in the worker client. Do not silently change these wire definitions: a refresh requires a new pinned source comparison and review. No server, engine, provider, transport, filesystem import or publication capability is copied here. ADR0020 owns the client boundary; ADR0021 owns this successor pin and the local host composition.
