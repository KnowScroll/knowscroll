# Starting from an issue or a report

From the issue worktree, use Node and pnpm from the workspace setup, Git, and optionally an authenticated GitHub CLI. Commands work in PowerShell and on macOS. The scripts use built-in Node modules. Paths are relative to this checkout.

| Task | First command |
| --- | --- |
| Resolve or audit | `pnpm issue-context 664` |
| Investigate a new report | `pnpm issue-context new "Next part"` |
| Investigate locally without GitHub | `pnpm issue-context new "Next part" --offline` |
| Read a saved issue body (first heading is the title) | `pnpm issue-context --file issue.md` |
| Read one decision in full | `pnpm issue-context decision D-319` |

## Resolving

Read the compact goal, criteria, owning files and relevant decision excerpts. Paths come from the brief and are checked against this worktree’s tracked files. Related headings are lexical suggestions. Check amendments in the decision log and refer to the linked issue for screenshots, full criteria and later discussion. Open the owning module README for its tests and runtime responsibilities. Choose the evidence appropriate to the issue. A recommendation audit needs dev observations; a phone overlay change needs the actual screen and a focused client test.

## Investigating and drafting

Use a short, non-sensitive symptom or distinctive UI phrase. The command searches local tracked code and compares titles from the 100 most recent GitHub issues, including closed issues. A limited title search can miss an older duplicate. Search all GitHub issues for alternate terms and inspect the strongest matches. For an existing issue, record the additional evidence there when authorized.

For a new issue, capture the user's goal and the actual behavior. Record the revision, reproduction, evidence source, expected result, owning modules, related decisions/design and an observable acceptance check. Distinguish reported behavior from your reproduction and a suspected cause from a confirmed defect. Use disposable accounts for experiments and redact private data in screenshots or logs. The command only reads. File the reviewed brief under the applicable tracker when requested.

## Handoff

On the issue or PR leave the worktree branch and commit, what you verified, the remaining uncertainty and the next useful command. Preserve owner decisions in the binding decision log. For historical comparisons, consult the [archive](../../archive/README.md).
