/**
 * The static migration registry. Every `NNNN_name.sql` file in this folder appears here exactly once, in apply order,
 * with the SHA-256 of its reviewed text. Adding a migration means adding its file and its entry;
 * a test fails if the registry and the folder disagree or a reviewed file changed.
 *
 * Never edit or delete an entry after it reached a shared database: write a new migration.
 */
export const migrationRegistry: readonly { readonly name: string; readonly sha256: string }[] = [
  { name: '0001_identity', sha256: '18f260b125ca28d4dbd67f974e3d1808ef9e92aa18a12ba5b4d48becaca551ff' },
  { name: '0002_receipts', sha256: '1fe95d96b8dfb09cc6a9e5d68bdcb5282e909d3e9a92361e2a9fdc795946e827' },
  { name: '0003_content_assets', sha256: '769c6ac85d47eaa5ef68288c3e7f0acc3f97a118008f3848c590dc81748c77be' },
  { name: '0004_experience_actions', sha256: 'e98d3e7a4544456e2b320500bca5ba47d4acc65da75ad00251211e1e67fd4476' },
  { name: '0005_evidence_action_events', sha256: 'cd48ecc1e17ae8cc84a6e1c511b6a9b80c8113eea10845cece7c28d22264f9ea' },
  { name: '0006_reasoning_ledger', sha256: '2bba0d0aa5137a0b9f3e6236e261e8e03063cb9ac5bbcdd41fd2dea64970fdd5' },
  { name: '0007_identity_sign_in', sha256: '6f63f94a2f2238a645bbef84fda68bf65e08f50617250368b6c680122edfa12c' },
  { name: '0008_ops_operator_sign_ins', sha256: 'b189ceb527a3d35e7a55687083e4efff140b1dcf2560f4c84b75d19247a1a2ec' },
  { name: '0009_reasoning_harness', sha256: '832be0760a3f416b8885f400c1727e3ce9aec93fe9ce71491c192c914b1da17a' },
];
