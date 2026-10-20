import { describe, expect, it } from 'vitest';
import type { EngineRecord, RunStatus, VideoResult } from './read-client.js';
import { validateEngineRecord } from './validate-record.js';

/** Synthetic metadata only: mirrors the observed 2/3-picture, 6-take completed runs. */
function fixture(pictured = [1, 3, 5]) {
  const status: RunStatus = {
    contractVersion: 1,
    runId: 'fixture-run',
    requestId: 'fixture-request',
    state: 'finished',
    lastSeq: 1,
  };
  const result: VideoResult = {
    contractVersion: 1,
    runId: status.runId,
    requestId: status.requestId,
    status: 'completed',
    until: 'video',
    costCents: 0,
    estimateCents: 0,
    stills: pictured.map((shot) => ({
      pictureId: `fixture-picture-${shot}`,
      shotId: `shot-${shot}`,
      path: `/fixture/${shot}.jpg`,
    })),
    video: { path: '/fixture/render.mp4' },
    degradations: [],
  };
  const record: EngineRecord = {
    contractVersion: 1,
    runId: status.runId,
    pictures: pictured.map((shot) => ({
      pictureId: `fixture-picture-${shot}`,
      shotId: `shot-${shot}`,
      chosen: true,
      checks: ['technical', 'text', 'witness', 'reconcile'].map((step) => ({
        gate: '1',
        step,
        outcome: 'accept',
      })),
    })),
    takes: Array.from({ length: 6 }, (_, index) => ({
      takeId: `fixture-take-${index + 1}`,
      shotId: `shot-${index + 1}`,
      number: 1,
      used: true,
      checks: ['2', '3', '4', '5'].map((gate) => ({ gate, outcome: 'accept' })),
    })),
    degradations: [],
  };
  return { status, result, record };
}
type Fixture = ReturnType<typeof fixture>;
const valid = ({ status, result, record }: Fixture) => validateEngineRecord(status, result, record);

describe('pinned Cutroom engine attestation (synthetic metadata)', () => {
  it.each([
    ['greenhouse topology', [1, 3, 5]],
    ['seasons topology', [1, 2]],
    ['tides topology', [1, 5]],
  ] as const)('accepts %s with six used takes', (_, pictured) => {
    const input = fixture([...pictured]);
    expect(
      input.record.takes.filter((take) => !input.record.pictures.some((p) => p.shotId === take.shotId)),
    ).not.toHaveLength(0);
    expect(valid(input)).toBe(true);
  });
  it.each(['2', '3', '4', '5'])('requires gate %s on an unpictured used take', (gate) => {
    const input = fixture();
    const take = input.record.takes[1]!;
    take.checks = take.checks.filter((check) => check.gate !== gate);
    expect(valid(input)).toBe(false);
  });
  it.each(['technical', 'text', 'witness', 'reconcile'])('requires Gate 1 %s on chosen pictures', (step) => {
    const input = fixture();
    const picture = input.record.pictures[0]!;
    picture.checks = picture.checks.filter((check) => check.step !== step);
    expect(valid(input)).toBe(false);
  });
  it.each(['pictured', 'unpictured', 'picture'] as const)('rejects any failed check on %s pieces', (kind) => {
    const input = fixture();
    const piece = kind === 'picture' ? input.record.pictures[0]! : input.record.takes[kind === 'pictured' ? 0 : 1]!;
    piece.checks.push({ gate: 'unexpected', outcome: 'fail' });
    expect(valid(input)).toBe(false);
  });
  const refusals: [string, (input: Fixture) => void][] = [
    [
      'running',
      ({ status }) => {
        status.state = 'running';
      },
    ],
    [
      'resumes',
      ({ status }) => {
        status.resumes = 'earlier-run';
      },
    ],
    [
      'resumedBy',
      ({ status }) => {
        status.resumedBy = 'later-run';
      },
    ],
    [
      'result run',
      ({ result }) => {
        result.runId = 'wrong-run';
      },
    ],
    [
      'record run',
      ({ record }) => {
        record.runId = 'wrong-run';
      },
    ],
    [
      'request',
      ({ result }) => {
        result.requestId = 'wrong-request';
      },
    ],
    [
      'copied picture',
      ({ record }) => {
        record.pictures[0]!.keptFrom = 'other-run';
      },
    ],
    [
      'copied unpictured take',
      ({ record }) => {
        record.takes[1]!.keptFrom = 'other-run';
      },
    ],
    [
      'no chosen pictures',
      ({ record }) => {
        record.pictures = [];
      },
    ],
    [
      'no used takes',
      ({ record }) => {
        record.takes = [];
      },
    ],
    [
      'duplicate chosen shot',
      ({ record }) => {
        record.pictures.push({ ...record.pictures[0]! });
      },
    ],
    [
      'duplicate used shot',
      ({ record }) => {
        record.takes.push({ ...record.takes[1]! });
      },
    ],
    [
      'wrong still picture',
      ({ result }) => {
        result.stills[0]!.pictureId = 'wrong-picture';
      },
    ],
    [
      'wrong still shot',
      ({ result }) => {
        result.stills[0]!.shotId = 'wrong-shot';
      },
    ],
    [
      'missing still',
      ({ result }) => {
        result.stills.pop();
      },
    ],
    [
      'extra still',
      ({ result }) => {
        result.stills.push({ ...result.stills[0]! });
      },
    ],
    [
      'uncovered pictured shot',
      ({ record }) => {
        record.takes[0]!.used = false;
      },
    ],
    [
      'degradation mismatch',
      ({ result }) => {
        result.degradations.push({ shotId: 'shot-1', reason: 'fixture-hold' });
      },
    ],
  ];
  it.each(refusals)('rejects %s', (_, mutate) => {
    const input = fixture();
    mutate(input);
    expect(valid(input)).toBe(false);
  });
  it('retains accepting labels and degradation coverage for a held pictured shot', () => {
    const input = fixture();
    input.record.takes[0]!.used = false;
    input.record.degradations.push({ shotId: 'shot-1', reason: 'fixture-hold' });
    input.result.degradations = structuredClone(input.record.degradations);
    input.record.takes[1]!.checks[0]!.outcome = 'accept_with_label';
    expect(valid(input)).toBe(true);
  });
});
