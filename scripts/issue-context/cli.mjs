// Contributor CLI. Uses Git and optionally gh, never a model or a product service.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decisionExcerpt, headings, owners, ranked, readingPaths, section } from './lookup.mjs';

const repo = 'KnowScroll/knowscroll';
const help = [
  'pnpm issue-context <issue-number>         resolve an existing issue',
  'pnpm issue-context --file <issue.md>      use a local Markdown brief offline',
  'pnpm issue-context new "symptom" [--offline]   investigate a report and check possible duplicates',
  'pnpm issue-context decision D-319        read one decision',
].join('\n');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: result.status === 0, status: result.status, output: result.stdout ?? '' };
}

function git(args, cwd) {
  const result = run('git', args, cwd);
  if (!result.ok) throw new Error('Git lookup failed. Run inside the issue worktree.');
  return result.output.trimEnd();
}

function github(args, cwd) {
  const result = run('gh', [...args, '--repo', repo], cwd);
  return result.ok ? JSON.parse(result.output) : undefined;
}

function brief(args, root) {
  if (args[0] === '--file' && args.length === 2) {
    const body = readFileSync(resolve(args[1]), 'utf8');
    return {
      title: body
        .trimStart()
        .split('\n')[0]
        .replace(/^#+\s*/, ''),
      body,
    };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) throw new Error(help);
  const issue = github(['issue', 'view', args[0], '--json', 'title,body,state,url'], root);
  if (!issue)
    throw new Error('Could not read #' + args[0] + '. Check gh access and issue number, or use --file <issue.md>.');
  return issue;
}

function list(title, entries, limit) {
  if (!entries.length) return;
  console.log('\n' + title);
  for (const entry of entries.slice(0, limit)) console.log('  ' + entry);
  if (entries.length > limit) console.log('  … ' + (entries.length - limit) + ' more; consult the full source.');
}

function sourceHits(text, root) {
  const args = ['-F', '-e', text, '--', '*.ts', '*.tsx', '*.mjs', '*.sql'];
  const exact = run('git', ['grep', '-Il', ...args], root);
  const result = exact.status === 1 ? run('git', ['grep', '-Iil', ...args], root) : exact;
  if (!result.ok && result.status !== 1) throw new Error('Source search failed. Retry with a shorter phrase.');
  return result.output.trim().split('\n').filter(Boolean);
}

function decisionsFor(title, body, sections) {
  const ids = new Set(body.match(/\bD-\d{3,}\b/g) ?? []);
  const explicit = sections.filter((section) => ids.has(section.id));
  // Product issue headings and code identifiers supply useful terms (e.g. LandmarkCard).
  const symbols = [...body.matchAll(/\x60([A-Z][a-z]+[A-Z]\w*)\x60/g)].map((match) =>
    match[1].replace(/([a-z])([A-Z])/g, '$1 $2'),
  );
  const suggestions = ranked([title, ...symbols].join(' '), sections)
    .filter((item) => !ids.has(item.id))
    .slice(0, 4);
  list(
    'Decisions cited by the brief',
    explicit.map((item) => item.id + ' ' + item.title),
    15,
  );
  list(
    'Related decision headings (search suggestions)',
    suggestions.map((item) => item.id + ' ' + item.title),
    4,
  );
}

function resolveIssue(args, context) {
  const { root, files, sections } = context;
  const { title, body, state, url } = brief(args, root);
  console.log((state ? state + ' ' : '') + title + (url ? '\n' + url : ''));
  const goal = section(body, /^(what should improve|goal|problem|description|summary)$/i) || body;
  console.log('\n' + goal.split(/\r?\n\s*\r?\n/)[0].slice(0, 550));
  const acceptance = section(body, /acceptance|done (when|means)/i);
  list(
    'Acceptance (see full issue for details)',
    acceptance
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(0, 300)),
    10,
  );
  const pointers = readingPaths(body, files);
  list('Verified paths in this checkout', pointers, 16);
  list(
    'Owning READMEs',
    owners(pointers, files).filter((path) => !pointers.includes(path)),
    8,
  );
  const test = pointers.find((path) => path.startsWith('apps/client/') && /\.test\.tsx?$/.test(path));
  if (test)
    console.log('\nFocused check: pnpm --dir apps/client test --runTestsByPath ' + test.slice('apps/client/'.length));
  if (!pointers.length)
    console.log('\nFind code and tests with: pnpm issue-context new "distinctive words from the report"');
  const pins = new Set(
    [...body.matchAll(/github\.com\/KnowScroll\/knowscroll\/(?:blob|tree)\/([a-f\d]{40})\//gi)].map(
      (match) => match[1],
    ),
  );
  for (const pin of pins)
    if (pin !== context.head)
      console.log('Issue links reference ' + pin.slice(0, 12) + '; inspect current source before editing.');
  decisionsFor(title, body, sections);
  console.log(
    '\nUse the full brief for evidence and remaining constraints. Match the check to the issue: UI reproduction, focused test or a dev operator journey.',
  );
}

function investigate(args, context) {
  const { root, files, sections } = context;
  const [symptom, flag] = args;
  if (!symptom?.trim() || symptom.length > 240 || args.length > 2 || (flag && flag !== '--offline'))
    throw new Error(help);
  console.log('Investigating: ' + symptom);
  const hits = sourceHits(symptom, root);
  list('Literal matches in tracked code and tests', hits, 8);
  const candidates = hits.length
    ? hits
    : ranked(
        symptom,
        [...files]
          .filter((path) => /^(apps|packages|tests)\//.test(path) && /\.(ts|tsx|mjs)$/.test(path))
          .map((path) => ({ title: path })),
      )
        .slice(0, 8)
        .map((hit) => hit.title);
  if (!hits.length) list('Path suggestions (no literal match)', candidates, 8);
  list('Owning READMEs', owners(candidates, files), 6);
  decisionsFor(symptom, '', sections);
  const issues =
    flag === '--offline'
      ? undefined
      : github(['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title,state'], root);
  if (issues) {
    const similar = ranked(symptom, issues).slice(0, 5);
    list(
      'Possible duplicates among the latest 100 open/closed issues',
      similar.map((hit) => '#' + hit.number + ' ' + hit.state + ' ' + hit.title),
      5,
    );
    console.log('Search the full issue history by symptom and area before filing.');
  } else console.log('Duplicate search unavailable or offline. Check GitHub before filing.');
  console.log(
    '\nDraft: user impact and expected behavior; steps, viewport and revision; observed vs reported evidence; likely owner and decision; acceptance/check; related issue or tracker. Redact personal data. Reuse an existing issue when it covers the report.',
  );
}

function main(args) {
  if (!args.length || ['-h', '--help'].includes(args[0])) {
    console.log(help);
    return;
  }
  const root = git(['rev-parse', '--show-toplevel']);
  const head = git(['rev-parse', 'HEAD'], root);
  const source = readFileSync(resolve(root, 'docs/v2/decisions.md'), 'utf8');
  const sections = headings(source);
  if (args[0] === 'decision') {
    if (args.length !== 2) throw new Error(help);
    console.log(decisionExcerpt(source, sections, args[1]));
    return;
  }
  const files = new Set(git(['ls-files', '-z'], root).split('\0').filter(Boolean));
  console.log('KnowScroll @ ' + head.slice(0, 12));
  if (args[0] === 'new') investigate(args.slice(1), { root, files, sections });
  else resolveIssue(args, { root, files, sections, head });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
