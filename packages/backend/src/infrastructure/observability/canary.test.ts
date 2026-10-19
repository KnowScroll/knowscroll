import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { diagnosticCatalogue, type DiagnosticEvent } from './catalogue.js';
import { FrameworkLogAdapter } from './framework-logger.js';
import { createEventLog } from './log-event.js';
import { sanitiseUrl } from './sanitise.js';

/**
 * Secret canary (blueprint §26): secret-shaped values injected into every place a diagnostic can
 * pick text up must never appear in the output. Every value here is a fixture.
 */
const canaries = {
  databasePassword: 'canary-db-password-7Hq2',
  apiKey: 'sk-canaryKEY0123456789abcdefghij',
  bearer: 'canary.bearer.token.Z9x8',
  presigned: 'canary-presigned-signature-Qw3',
  magicLink: 'canary-magic-link-token-Lm4',
  cookie: 'canary-session-cookie-Pp5',
  prompt: 'CANARY PROMPT tell me about my private life',
  chat: 'CANARY CHAT meet me at the usual place',
  githubToken: 'ghp_canaryCANARYcanaryCANARYcanary0123',
} as const;

const secretUrl = `postgres://ks_api:${canaries.databasePassword}@db.internal:5432/knowscroll`;
const presignedUrl = `https://oss.example/video.mp4?X-Amz-Signature=${canaries.presigned}&Expires=1700000000`;
const magicLinkUrl = `https://app.knowscroll.space/auth/confirm?token=${canaries.magicLink}`;

function nestedError(): Error {
  const root = new Error(`provider said: ${canaries.prompt} key=${canaries.apiKey}`);
  const middle = new Error(`fetch ${presignedUrl} failed (Authorization: Bearer ${canaries.bearer})`, { cause: root });
  const outer = new TypeError(`could not connect to ${secretUrl}; chat body: ${canaries.chat}`, { cause: middle });
  return Object.assign(outer, {
    code: 'ECONNREFUSED',
    config: {
      headers: { authorization: `Bearer ${canaries.bearer}`, cookie: `session=${canaries.cookie}` },
      url: magicLinkUrl,
    },
    request: { body: canaries.chat },
  });
}

function captured() {
  let output = '';
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString('utf8');
      callback();
    },
  });
  return {
    logEvent: createEventLog({
      service: 'canary',
      environment: 'ci',
      revision: 'unknown',
      destination,
      minimumSeverity: 'debug',
    }),
    output: () => output,
  };
}

function expectNoCanary(output: string): void {
  for (const [name, value] of Object.entries(canaries))
    expect({ name, leaked: output.includes(value) }).toEqual({ name, leaked: false });
  expect(output).not.toContain('canary-');
}

describe('the secret canary', () => {
  it('never lets a secret through any catalogued event field', () => {
    const { logEvent, output } = captured();
    const hostile = [
      secretUrl,
      presignedUrl,
      magicLinkUrl,
      `Bearer ${canaries.bearer}`,
      `cookie: session=${canaries.cookie}`,
      canaries.prompt,
      canaries.chat,
      canaries.githubToken,
    ];
    for (const event of Object.keys(diagnosticCatalogue) as DiagnosticEvent[]) {
      for (const text of hostile) {
        const fields: Record<string, unknown> = { severity: 'error' };
        for (const field of diagnosticCatalogue[event].fields)
          fields[field] = field === 'error' ? nestedError() : field === 'problems' ? [text] : text;
        (logEvent as (name: string, values: Record<string, unknown>) => void)(event, fields);
      }
    }
    expect(output().length).toBeGreaterThan(0);
    expectNoCanary(output());
  });

  it('never lets a secret through the framework adapter', () => {
    const { logEvent, output } = captured();
    const adapter = new FrameworkLogAdapter(logEvent);
    adapter.log(`Mapped route for ${canaries.chat}`, 'SomeLibrary');
    adapter.log(`Connecting to ${secretUrl}`, 'NestApplication');
    adapter.warn(`retrying ${presignedUrl}`, 'ExceptionsHandler');
    adapter.error(`request failed: ${canaries.prompt}`, nestedError().stack, 'ExceptionsHandler');
    adapter.error(nestedError());
    adapter.fatal(`fatal with Bearer ${canaries.bearer}`);
    expectNoCanary(output());
  });

  it('drops credential-bearing query strings and userinfo from URLs', () => {
    expectNoCanary([sanitiseUrl(secretUrl), sanitiseUrl(presignedUrl), sanitiseUrl(magicLinkUrl)].join('\n'));
  });
});
