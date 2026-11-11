import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdownOf, outputDirectory, type GroupReport } from './report.js';

/**
 * Vitest global setup of the simulation project. Each test file writes `report-<group>.json`; when every file has
 * finished, the teardown merges them into `report.json` and `summary.md` in the same directory (the CI artifact) and,
 * on GitHub Actions, into the job summary. Stale group reports from an earlier run are removed first.
 */
export default function setup(): () => void {
  const directory = outputDirectory();
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(directory))
    if (/^report(-.*)?\.json$|^summary\.md$/.test(name)) rmSync(join(directory, name));
  return () => {
    const reports = readdirSync(directory)
      .filter((name) => /^report-.*\.json$/.test(name))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as GroupReport);
    if (reports.length === 0) return;
    const markdown = markdownOf(reports);
    writeFileSync(join(directory, 'report.json'), `${JSON.stringify({ groups: reports }, null, 2)}\n`);
    writeFileSync(join(directory, 'summary.md'), markdown);
    const summary = process.env['GITHUB_STEP_SUMMARY'];
    if (summary !== undefined && existsSync(summary)) appendFileSync(summary, `${markdown}\n`);
  };
}
