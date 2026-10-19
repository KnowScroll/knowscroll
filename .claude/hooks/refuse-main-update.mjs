// PreToolUse hook: an agent never updates `main`. Only the owner or XZNON promote to live, by hand
// (scripts/promote.sh live from their own terminal). The agent uses the owner's GitHub account, so
// GitHub cannot tell them apart; this refusal in the agent's own tools is the guard.
// Exit 2 blocks the Bash call and shows the reason to the agent.
//
// The rules are deliberately broad: a false refusal costs the agent one reworded command, while a
// missed one can publish to production. Tested by refuse-main-update.test.mjs (run in CI).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const END = String.raw`(?=$|[\s"';)&|])`;
const MAIN_REF = String.raw`["']?(?:\S*:)?(?:refs/heads/)?main["']?${END}`;
const GIT_PUSH = String.raw`\bgit\b[^\n|;&]*?\spush\b`;

const RULES = [
  [new RegExp(String.raw`${GIT_PUSH}[^\n|;&]*\s${MAIN_REF}`), 'git push to main'],
  [new RegExp(String.raw`${GIT_PUSH}[^\n|;&]*\s(?:--mirror|--all)\b`), 'git push --all/--mirror (would include main)'],
  [new RegExp(String.raw`refs/heads/main${END}`), 'a direct update of refs/heads/main'],
  [new RegExp(String.raw`promote\.sh["']?\s+["']?live${END}`), 'promotion to live'],
  [new RegExp(String.raw`\bgh\s+api\b[^\n]*\bbase=["']?main${END}`), 'a GitHub API merge into main'],
  [new RegExp(String.raw`\bgh\s+repo\s+sync\b[^\n]*--branch[=\s]+["']?main${END}`), 'gh repo sync of main'],
];

/** Returns the refusal reason for a command, or null when it may run. */
export function refusalFor(command, { cwd, currentBranch, prBase } = {}) {
  for (const [pattern, what] of RULES) {
    if (pattern.test(command)) return what;
  }
  // A bare `git push` (no refspec) from a checkout of main pushes main.
  if (/\bgit\b[^\n|;&]*?\spush\s*(?:$|[|;&]|-u\s+origin\s*$|origin\s*$)/.test(command)) {
    if ((currentBranch ?? branchOf(cwd)) === 'main') return 'a bare git push from main';
  }
  // `gh pr merge <n>` into main: ask GitHub for the PR's base branch.
  const merge = command.match(/\bgh\s+pr\s+merge\b(?:\s+(\d+))?/);
  if (merge) {
    const base = prBase ?? baseOfPullRequest(merge[1], cwd);
    if (base === 'main' || base === undefined) {
      return base === 'main' ? 'merging a pull request into main' : 'gh pr merge whose base branch could not be confirmed';
    }
  }
  return null;
}

function branchOf(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return undefined;
  }
}

function baseOfPullRequest(number, cwd) {
  try {
    const args = ['pr', 'view', ...(number ? [number] : []), '--json', 'baseRefName', '--jq', '.baseRefName'];
    return execFileSync('gh', args, { cwd, encoding: 'utf8', timeout: 8000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const command = String(input?.tool_input?.command ?? '');
  const reason = refusalFor(command, { cwd: input?.cwd });
  if (reason) {
    process.stderr.write(
      `Refused: ${reason}. Only the owner or XZNON update main; ask them to run "scripts/promote.sh live" or merge the main-targeted PR.\n`,
    );
    process.exit(2);
  }
}
