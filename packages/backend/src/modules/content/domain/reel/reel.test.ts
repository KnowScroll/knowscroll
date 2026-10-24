import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RECIPES } from '../library/index.js';
import { checkReelScript, MAX_WORDS_PER_SENTENCE, type ReelFinding } from './check.js';
import { checkEngineRecord, foldChain, type ChainRun, type EngineRecordFacts, type RunResultFacts } from './chain.js';
import { findRepetition, reelFingerprints } from './fingerprint.js';
import { compileReelRequest, reelRequestId, reelScriptDigest } from './request.js';
import { ReelScriptSchema, type ReelScript } from './script.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const scroll = RECIPES['stars-fusion'].assetId;

/** Labelled fixture: a well-formed script about the stars-fusion recipe, not an approved one. */
function fixtureScript(change: (script: ReelScript) => void = () => undefined): ReelScript {
  const script: ReelScript = ReelScriptSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    authoredBy: 'unit test fixture',
    approval: { ref: 'fixture', approvedBy: 'nobody', approvedAt: '2026-01-01' },
    recipe: 'stars-fusion',
    brief: {
      version: 1,
      worldId: 'fixture-world',
      narration: [
        { text: 'A star glows in the dark.', claimIds: ['c1'] },
        { text: 'It does not fall in on itself.', claimIds: ['c1'] },
        { text: 'Hot gas pushes outward from its core.', claimIds: ['c2'] },
        { text: 'That push balances the pull inward.', claimIds: ['c2'] },
        { text: 'A heavier star burns faster.', claimIds: ['c3'] },
        { text: 'A lighter star burns slowly.', claimIds: ['c3'] },
      ],
      claims: [
        { id: 'c1', role: 'main' },
        { id: 'c2', role: 'main' },
        { id: 'c3', role: 'supporting' },
      ],
      claimSources: ['c1', 'c2', 'c3'].map((claimId) => ({ claimId, assetId: scroll, assetRevision: 1 })),
      criteria: {
        mustShow: [
          { id: 'show-a', text: 'a bright star', type: 'presence', claimId: 'c1' },
          { id: 'show-b', text: 'a ball of gas', type: 'presence', claimId: 'c2' },
          { id: 'show-c', text: 'two stars', type: 'presence', claimId: 'c3' },
        ],
        mustNotShow: [
          { id: 'never-person', text: 'a recognisable real-world public figure', type: 'presence' },
          { id: 'never-text', text: 'written words or labels', type: 'presence' },
        ],
        depictionPolicyVersion: 'policy-3',
      },
      style: { id: 'style-fixture', version: 1, text: 'plain footage' },
      title: 'Fixture',
      summary: 'A fixture.',
    },
  });
  change(script);
  return script;
}
const codes = (findings: readonly ReelFinding[]) => findings.map((finding) => finding.code);
const mutable = <T>(value: T) => value;

describe('checkReelScript', () => {
  it('accepts a well-formed script', () => {
    expect(checkReelScript(fixtureScript())).toEqual([]);
  });

  it('refuses an unknown recipe before anything else', () => {
    const script = { ...fixtureScript(), recipe: 'no-such-recipe' };
    expect(codes(checkReelScript(script))).toEqual(['recipe_unknown']);
  });

  it('refuses too few sentences, a sentence ending on "Sun" and one that is too long', () => {
    const script = fixtureScript((s) => {
      mutable(s.brief).narration = [
        { text: 'The star warms the field below the Sun.', claimIds: ['c1'] },
        { text: Array.from({ length: MAX_WORDS_PER_SENTENCE + 1 }, () => 'word').join(' ') + '.', claimIds: ['c2'] },
        { text: 'No full stop here', claimIds: ['c3'] },
      ];
    });
    const found = codes(checkReelScript(script));
    expect(found).toEqual(
      expect.arrayContaining(['sentence_count', 'sentence_ends_on_sun', 'sentence_too_long', 'sentence_not_complete']),
    );
  });

  it('allows "Sun" inside a sentence and a possessive at its end', () => {
    const script = fixtureScript((s) => {
      mutable(s.brief.narration[0]!).text = 'The Sun warms the field below it.';
      mutable(s.brief.narration[1]!).text = 'It circles the Sun’s own light.';
    });
    expect(codes(checkReelScript(script))).toEqual([]);
  });

  it('refuses claims that no sentence uses, unknown claims and claims without a source or a scene', () => {
    const script = fixtureScript((s) => {
      mutable(s.brief).claims = [...s.brief.claims, { id: 'c9', role: 'supporting' }];
      mutable(s.brief.narration[0]!).claimIds = ['c1', 'missing'];
      mutable(s.brief).claimSources = s.brief.claimSources.filter((source) => source.claimId !== 'c2');
    });
    expect(codes(checkReelScript(script))).toEqual(
      expect.arrayContaining(['claim_unreferenced', 'claim_unlisted', 'claim_without_source', 'claim_without_scene']),
    );
  });

  it('requires every claim to rest on the twin Scroll', () => {
    const script = fixtureScript((s) => {
      mutable(s.brief.claimSources[0]!).assetId = RECIPES['tides-spring-neap'].assetId;
    });
    expect(codes(checkReelScript(script))).toEqual(['source_not_recipe_scroll']);
  });

  it('requires the standing prohibitions and presence-only prohibitions', () => {
    const script = fixtureScript((s) => {
      mutable(s.brief.criteria).mustNotShow = [
        { id: 'never-person', text: 'a recognisable real-world public figure', type: 'event' },
      ];
    });
    expect(codes(checkReelScript(script))).toEqual(
      expect.arrayContaining(['must_not_show_not_presence', 'must_not_show_standing_rules_missing']),
    );
  });
});

describe('fingerprints', () => {
  it('are stable for the same script and differ with its words', () => {
    const first = reelFingerprints(fixtureScript().brief, sha256);
    expect(reelFingerprints(fixtureScript().brief, sha256)).toEqual(first);
    const reworded = fixtureScript((s) => {
      mutable(s.brief.narration[0]!).text = 'A different first sentence.';
    });
    const second = reelFingerprints(reworded.brief, sha256);
    expect(second.templateSha256).toBe(first.templateSha256);
    expect(second.argumentSha256).not.toBe(first.argumentSha256);
    expect(second.bridgeSha256).not.toBe(first.bridgeSha256);
  });

  it('name which fingerprint a repeat shares', () => {
    const base = reelFingerprints(fixtureScript().brief, sha256);
    const onRecord = [{ label: 'earlier', ...base }];
    expect(findRepetition(base, onRecord)).toEqual({ label: 'earlier', shared: 'template' });
    const otherStructure = fixtureScript((s) => {
      mutable(s.brief.style).id = 'style-other';
    });
    const sameWords = reelFingerprints(otherStructure.brief, sha256);
    expect(findRepetition(sameWords, onRecord)).toEqual({ label: 'earlier', shared: 'argument' });
    const nothingShared = fixtureScript((s) => {
      mutable(s.brief.style).id = 'style-other';
      mutable(s.brief).worldId = 'another-world';
      mutable(s.brief.narration[0]!).text = 'Another opening.';
    });
    expect(findRepetition(reelFingerprints(nothingShared.brief, sha256), onRecord)).toBeUndefined();
  });

  it('ignore the order and spacing of sentences in the bridge', () => {
    const reordered = fixtureScript((s) => {
      mutable(s.brief).narration = [...s.brief.narration].reverse();
      mutable(s.brief.narration[0]!).text = `  ${s.brief.narration[0]!.text.toUpperCase()}  `;
    });
    expect(reelFingerprints(reordered.brief, sha256).bridgeSha256).toBe(
      reelFingerprints(fixtureScript().brief, sha256).bridgeSha256,
    );
  });
});

describe('compileReelRequest', () => {
  const script = fixtureScript();

  it('builds the wire body Cutroom accepts, without KnowScroll-only fields', () => {
    const request = compileReelRequest(script, { until: 'video', take: 2, ceilingCents: 60 }, sha256);
    const body = JSON.parse(request.requestUtf8) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      'contractVersion',
      'requestId',
      'worldId',
      'narration',
      'claims',
      'criteria',
      'style',
      'options',
    ]);
    expect(body['options']).toEqual({ until: 'video', budgetCents: 60 });
    expect(request.requestUtf8).not.toContain('claimSources');
    expect(request.requestUtf8).not.toContain(scroll);
    expect(request.requestSha256).toBe(sha256(request.requestUtf8));
    expect(request.requestId).toBe(`ks-reel-${request.scriptSha256.slice(0, 32)}-2`);
  });

  it('gives the same bytes for the same input and a new id for a new take', () => {
    const options = { until: 'video', take: 1, ceilingCents: 75 } as const;
    expect(compileReelRequest(script, options, sha256)).toEqual(compileReelRequest(script, options, sha256));
    expect(compileReelRequest(script, { ...options, take: 2 }, sha256).requestId).not.toBe(
      compileReelRequest(script, options, sha256).requestId,
    );
  });

  it('keeps the script identity apart from take and ceiling, and a rehearsal apart from an order', () => {
    const video = reelScriptDigest(script, 'video', sha256);
    expect(compileReelRequest(script, { until: 'video', take: 5, ceilingCents: 10 }, sha256).scriptSha256).toBe(video);
    expect(reelScriptDigest(script, 'plan', sha256)).not.toBe(video);
    expect(reelRequestId(video, 3)).toBe(`ks-reel-${video.slice(0, 32)}-3`);
  });
});

describe('foldChain', () => {
  const requestId = 'ks-reel-x-1';
  const result = (runId: string, status: RunResultFacts['status'], costCents: number): RunResultFacts => ({
    runId,
    requestId,
    status,
    costCents,
    until: 'video',
  });
  const run = (runId: string, extra: Partial<ChainRun['status']>, finished?: RunResultFacts): ChainRun => ({
    status: { runId, requestId, state: finished ? 'finished' : 'running', ...extra },
    result: finished,
  });

  it('is running while the only run runs', () => {
    expect(foldChain(requestId, [run('a', {})])).toEqual({ kind: 'running', runIds: ['a'] });
  });

  it('is finished with the run’s own cost when nothing continued it', () => {
    const report = foldChain(requestId, [run('a', {}, result('a', 'stopped', 48))]);
    expect(report).toMatchObject({ kind: 'finished', outcome: 'stopped', costCents: 48, finalRunId: 'a' });
  });

  it('is not finished while a failed run is being continued, and sums both runs when it ends', () => {
    const failed = run('a', { resumedBy: 'b' }, result('a', 'failed', 34));
    expect(foldChain(requestId, [failed])).toEqual({ kind: 'running', runIds: ['a'] });
    const child = run('b', { resumes: 'a' }, result('b', 'completed', 12));
    expect(foldChain(requestId, [failed, child])).toMatchObject({
      kind: 'finished',
      outcome: 'completed',
      costCents: 46,
      finalRunId: 'b',
      runIds: ['a', 'b'],
    });
  });

  it('refuses chains that do not link, belong to another request or are too long', () => {
    expect(foldChain(requestId, [])).toEqual({ kind: 'broken', code: 'chain_length' });
    const failed = run('a', { resumedBy: 'b' }, result('a', 'failed', 1));
    const stranger = run('c', { resumes: 'a' }, result('c', 'completed', 1));
    expect(foldChain(requestId, [failed, stranger])).toEqual({ kind: 'broken', code: 'chain_links' });
    const other = { ...run('b', { resumes: 'a' }, result('b', 'completed', 1)) };
    expect(foldChain('another', [other])).toEqual({ kind: 'broken', code: 'chain_request' });
    const third = run('d', { resumes: 'b' }, result('d', 'completed', 1));
    const middle = run('b', { resumes: 'a', resumedBy: 'd' }, result('b', 'failed', 1));
    expect(foldChain(requestId, [failed, middle, third])).toEqual({ kind: 'broken', code: 'chain_length' });
  });
});

describe('checkEngineRecord', () => {
  const tip: RunResultFacts = {
    runId: 'r',
    requestId: 'q',
    status: 'completed',
    until: 'video',
    costCents: 50,
    stills: [{ pictureId: 'p1', shotId: 's1' }],
    videoPath: '/x/r/a1-render.mp4',
    degradations: [],
  };
  const accept = (gate: string, step?: string) => ({ gate, step, outcome: 'accept' });
  const failing = (checks: readonly { gate: string; step?: string | undefined; outcome: string }[], at: number) =>
    checks.map((check, index) => (index === at ? { ...check, outcome: 'fail' } : check));
  const pictureChecks = ['technical', 'text', 'witness', 'reconcile'].map((step) => accept('1', step));
  const takeChecks = ['2', '3', '4', '5'].map((gate) => accept(gate));
  const base: EngineRecordFacts = {
    runId: 'r',
    pictures: [{ pictureId: 'p1', shotId: 's1', chosen: true, checks: pictureChecks }],
    takes: [
      { shotId: 's1', used: true, checks: takeChecks },
      { shotId: 's2', used: true, checks: takeChecks },
    ],
    degradations: [],
  };

  it('attests a record whose pieces all passed', () => {
    expect(checkEngineRecord(tip, base, undefined)).toBe('ok');
  });

  it('refuses a failed check on a used take or a chosen picture', () => {
    const failedTake = { ...base, takes: [{ ...base.takes[0]!, checks: failing(takeChecks, 0) }, base.takes[1]!] };
    expect(checkEngineRecord(tip, failedTake, undefined)).toBe('record_take');
    const picture = { ...base.pictures[0]!, checks: failing(pictureChecks, 1) };
    expect(checkEngineRecord(tip, { ...base, pictures: [picture] }, undefined)).toBe('record_picture');
  });

  it('accepts a piece copied from the continued run and no other', () => {
    const copied = { ...base, pictures: [{ ...base.pictures[0]!, keptFrom: 'parent' }] };
    expect(checkEngineRecord(tip, copied, 'parent')).toBe('ok');
    expect(checkEngineRecord(tip, copied, 'someone-else')).toBe('record_picture');
    expect(checkEngineRecord(tip, copied, undefined)).toBe('record_picture');
  });

  it('refuses a record of another run, a shot with neither a take nor a degradation, and other degradations', () => {
    expect(checkEngineRecord(tip, { ...base, runId: 'other' }, undefined)).toBe('record_identity');
    expect(checkEngineRecord(tip, { ...base, takes: [base.takes[1]!] }, undefined)).toBe('record_shots');
    const degraded = { ...base, degradations: [{ shotId: 's2', reason: 'x' }] };
    expect(checkEngineRecord(tip, degraded, undefined)).toBe('record_shots');
  });
});
