import { guardedImagePort } from '@knowscroll/backend/reasoning/nest-providers';
import type { ImageOutcome, ImagePort } from '@knowscroll/backend/reasoning';

/**
 * CI FIXTURE: a labelled stand-in for the image provider. It never touches the network and never returns provider
 * output: every outcome is scripted by the test that created it, and the "picture" is a few JPEG header bytes with the
 * call's number after them, so each is a different file. It lives in test support, not in the backend package: no
 * deployed build contains it and no composition root can select it. It is wrapped by the same transaction guard as the
 * real transport.
 *
 * A scenario is an `ImageOutcome` as the real transport would produce it, or `hold`, which waits for the test and then
 * plays the scenario it is given (to make two operators overlap).
 */
export type FixtureImageScenario =
  | { readonly kind: 'image' }
  | { readonly kind: 'rejected' | 'not_sent' | 'unknown' | 'unusable'; readonly code?: string }
  | { readonly kind: 'hold'; readonly until: Promise<FixtureImageScenario> };

export interface FixtureImagePort extends ImagePort {
  /** Every request that reached the fixture (after the transaction guard), in order. */
  readonly calls: readonly { readonly sequence: number; readonly prompt: string }[];
}

const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

async function outcomeOf(scenario: FixtureImageScenario, sequence: number): Promise<ImageOutcome> {
  switch (scenario.kind) {
    case 'image':
      return {
        kind: 'image',
        mime: 'image/jpeg',
        bytes: new Uint8Array(Buffer.concat([JPEG_HEADER, Buffer.from(`fixture-picture-${String(sequence)}`)])),
      };
    case 'hold':
      return outcomeOf(await scenario.until, sequence);
    case 'unusable':
      return { kind: 'unusable', code: scenario.code ?? 'IMAGE_NOT_RECOGNISED' };
    case 'rejected':
    case 'not_sent':
    case 'unknown':
      return { kind: scenario.kind, code: scenario.code ?? 'FIXTURE' };
  }
}

/** A labelled fixture image provider whose every request plays `script` (default: one picture). */
export function fixtureImagePort(
  script: (sequence: number) => FixtureImageScenario | Promise<FixtureImageScenario> = () => ({ kind: 'image' }),
  options: { readonly requestTimeoutMs?: number } = {},
): FixtureImagePort {
  const calls: { sequence: number; prompt: string }[] = [];
  const port: FixtureImagePort = {
    provider: 'minimax',
    model: 'ci-fixture-image',
    requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
    calls,
    async generate(request) {
      const sequence = calls.length + 1;
      calls.push({ sequence, prompt: request.prompt });
      return outcomeOf(await script(sequence), sequence);
    },
  };
  return guardedImagePort(port);
}
