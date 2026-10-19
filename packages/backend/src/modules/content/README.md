# modules/content

Owns: `content.assets` (migration `0003_content_assets`): asset identity, current revision, kind
(`reel`/`scroll`) and admission status. The content module proper (explanation units, immutable
revisions, variants, publication, Cutroom import) arrives in Phase 2.

Public surface: the port type `FindAssetForAction` and token `FIND_ASSET_FOR_ACTION` — does the
asset exist, admitted, at which revision (read in the caller's transaction, no lock). Implemented
in `adapters/postgres-store.ts`, bound by `adapters/nest-providers.ts`.

`adapters/cutroom/wire-v1/` is the byte-for-byte vendored Cutroom wire schema (CF-61): not built,
linted or formatted; verified by the `integrity` CI job. Not personal data: no erasure entry.
