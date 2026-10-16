// PreToolUse hook (#201): an agent never updates `main`. Only the owner or XZNON promote to live,
// by hand (scripts/promote.sh live from their own terminal). The agent uses the owner's GitHub
// account, so GitHub cannot tell them apart; this refusal in the agent's own tools is the guard.
// Exit 2 blocks the Bash call and shows the reason to the agent.
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const command = String(input?.tool_input?.command ?? '');
const END = String.raw`(?=$|[\s"';)&|])`;

const rules = [
  [new RegExp(String.raw`\bgit\s+push\b[^\n]*\s(?:\S*:)?(?:refs/heads/)?main${END}`), 'git push to main'],
  [new RegExp(String.raw`\bgit\s+push\b[^\n]*\s(?:--mirror|--all)\b`), 'git push --all/--mirror (would include main)'],
  [new RegExp(String.raw`refs/heads/main${END}`), 'a direct update of refs/heads/main'],
  [new RegExp(String.raw`promote\.sh\s+live${END}`), 'promotion to live'],
];

for (const [pattern, what] of rules) {
  if (pattern.test(command)) {
    process.stderr.write(
      `Refused (#201): ${what}. Only the owner or XZNON update main; ask them to run "scripts/promote.sh live".\n`,
    );
    process.exit(2);
  }
}
