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
  { name: '0009_reasoning_harness', sha256: '9f4e4051e4a99817cfdb97ea51595d4a1ac6cb44033352cd5fa364cc04bca47b' },
  { name: '0010_content_asset_revisions', sha256: 'b5cb965ee587dff573c3496ee6f138a3ae31e054651657eb37717064bcd7930e' },
  { name: '0011_experience_exposures', sha256: '50aeb8064eac0756bb408bd19b04d80808809a2a21d964bae11dbb1ab3b516da' },
  { name: '0012_evidence_observations', sha256: '9a6c0eccd547e92c19824792b40eeec5c611cd3a7b2df161bbaaf08251610021' },
  {
    name: '0013_reasoning_production_scope',
    sha256: 'bbdf12ab2d89105f8ec24accad55a1a537ed8a9cac7ac911a71981dc208bfce3',
  },
  { name: '0014_media_reels', sha256: 'bbdc0029ed20d50e859068553584ae1eae3eff284f4517388e904ea66cf4c7b7' },
  { name: '0015_scroll_production', sha256: '1d9b68241734654d33129a38fb39147315df380a39b8a7d3f42ea2c694874420' },
  { name: '0016_content_discovery', sha256: 'b8a3f2dcde57a164f31455270bddfd392ddac168ac8574c79145db18fcdfac00' },
  { name: '0017_composer_decisions', sha256: '83dd77f63b5c5ea6935d92207ea933e5172fe89095f91640350647ad8aedf202' },
  { name: '0018_experience_navigation', sha256: '34f74aaedd40a1f9dd40a70b3d5b69226a6a956602dfcb4918feddc90a50ce88' },
  { name: '0019_evidence_activity', sha256: '764f3f88924cbc986a10cb780fbfd19ed750340c5fa1b3452b7713378b46a028' },
  { name: '0020_personal_context', sha256: '0b5c11d5dfaa59fd7e44db853e13e478467d729b06bda40484881060f05d7955' },
  { name: '0021_personal_planner', sha256: 'e46d135b8f7d8d7136daf9dbb284f345dd7b68efe11a46c2a8277b63cabb8447' },
  { name: '0022_content_coverage', sha256: 'a5f6204623b8777d830061ed73f38189eae1ace805acdc862e6b73e42c99202b' },
];
