import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createEventLog, sanitiseError, sanitiseUrl } from './index.js';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(
        ...chunk
          .toString('utf8')
          .split('\n')
          .filter((line) => line.length > 0),
      );
      callback();
    },
  });
  const logEvent = createEventLog({ service: 'test', environment: 'ci', revision: 'unknown', destination });
  return { logEvent, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('logEvent', () => {
  it('writes a versioned record with service, environment, revision and event name', () => {
    const { logEvent, records } = capture();
    logEvent('process.started', { pid: 42, nodeVersion: 'v22.23.0' });
    expect(records()).toEqual([
      expect.objectContaining({
        schemaVersion: 'diagnostic.v1',
        level: 'info',
        service: 'test',
        environment: 'ci',
        revision: 'unknown',
        event: 'process.started',
        pid: 42,
        nodeVersion: 'v22.23.0',
      }),
    ]);
  });

  it('withholds personal-linkable IDs from the journal and counts them', () => {
    const { logEvent, records } = capture();
    logEvent('jobs.job_failed', { queue: 'evidence.apply-action', jobId: 'job-1', retryCount: 1 });
    const [record] = records();
    expect(record).not.toHaveProperty('jobId');
    expect(record).toMatchObject({ queue: 'evidence.apply-action', retryCount: 1, withheldFields: 1 });
  });

  it('rejects field values outside their vocabulary instead of writing them', () => {
    const { logEvent, records } = capture();
    logEvent('http.request_completed', { method: 'GET', route: '/v1/items?token=abc', status: 200 });
    const [record] = records();
    expect(record).not.toHaveProperty('route');
    expect(record).toMatchObject({ method: 'GET', status: 200, rejectedFields: 1 });
  });
});

describe('sanitiseError', () => {
  it('keeps class, stable code and frames, and drops the message', () => {
    const error = Object.assign(new TypeError('connect to postgres://u:pw@h/db failed'), { code: 'ECONNREFUSED' });
    const sanitised = sanitiseError(error);
    expect(sanitised.errorClass).toBe('TypeError');
    expect(sanitised.code).toBe('ECONNREFUSED');
    expect(JSON.stringify(sanitised)).not.toContain('pw@');
    expect(sanitised.frames.length).toBeGreaterThan(0);
  });
});

describe('sanitiseUrl', () => {
  it('drops credentials and credential-like query strings', () => {
    expect(sanitiseUrl('https://user:pw@media.example/a.mp4?X-Amz-Signature=abc&x=1')).toBe(
      'https://media.example/a.mp4',
    );
    expect(sanitiseUrl('/v1/auth/callback?code=secret')).toBe('/v1/auth/callback');
    expect(sanitiseUrl('/v1/items?page=2')).toBe('/v1/items?page=2');
  });
});
