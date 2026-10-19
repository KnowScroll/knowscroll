/**
 * The static migration registry. Every `NNNN_name.sql` file in this folder appears here exactly once, in apply order,
 * with the SHA-256 of its reviewed text. Adding a migration means adding its file and its entry;
 * a test fails if the registry and the folder disagree or a reviewed file changed.
 *
 * Never edit or delete an entry after it reached a shared database: write a new migration.
 */
export const migrationRegistry: readonly { readonly name: string; readonly sha256: string }[] = [
  { name: '0001_identity', sha256: '2fe2442e8b1cf740837349c8125220e357cc7fb16a3314e6293289fd7537fb86' },
  { name: '0002_receipts', sha256: '1fe95d96b8dfb09cc6a9e5d68bdcb5282e909d3e9a92361e2a9fdc795946e827' },
  { name: '0003_content_assets', sha256: '769c6ac85d47eaa5ef68288c3e7f0acc3f97a118008f3848c590dc81748c77be' },
  { name: '0004_experience_actions', sha256: 'e98d3e7a4544456e2b320500bca5ba47d4acc65da75ad00251211e1e67fd4476' },
  { name: '0005_evidence_action_events', sha256: 'cd48ecc1e17ae8cc84a6e1c511b6a9b80c8113eea10845cece7c28d22264f9ea' },
  { name: '0006_reasoning_ledger', sha256: '956427d73c1f084bf9596acd3d7d4f1a0e1d44307921049b2fdffca81ba12d7e' },
];
