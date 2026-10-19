/**
 * The static migration registry. Every `NNNN_name.sql` file in this folder appears here exactly once, in apply order,
 * with the SHA-256 of its reviewed text. Adding a migration means adding its file and its entry;
 * a test fails if the registry and the folder disagree or a reviewed file changed.
 *
 * Never edit or delete an entry after it reached a shared database: write a new migration.
 */
export const migrationRegistry: readonly { readonly name: string; readonly sha256: string }[] = [];
