import { describe, expect, it, vi } from 'vitest';
import type { LibraryPassageSource } from '../../content/public.js';
import { GROUND_MAX_PASSAGES, GROUND_MAX_PER_ASSET, GROUND_PASSAGE_CHARS } from '../domain/answer-support.js';
import { KEPT_OUT_MESSAGE, KEPT_OUT_TOPIC } from '../domain/membership.js';
import { aboutText, chooseGround, makeReadGround, windowOf } from './answer-ground.js';

/** CI fixtures: invented Scroll text about an invented moon, never library text. */
const source = (assetId: string, title: string, ...blocks: string[]): LibraryPassageSource => ({
  assetId,
  assetRevision: 1,
  title,
  summary: '',
  blocks: blocks.map((text, index) => ({ blockId: `s${String(index + 1)}`, text })),
});

const DRIFT =
  'The moon of Veld drifts away from its planet by about 3.8 centimetres every year. Scientists measure the drift with lasers bounced off mirrors left on the surface.';
const TIDES =
  'Ocean tides rise and fall because the moon pulls on the water. There are two bulges, one facing the moon and one on the far side.';
const KETTLE = 'A kettle boils water when the heater is on.';
const QUESTION = 'How do scientists know the moon is slowly drifting away from the planet?';

describe('the words a question is matched against', () => {
  const messages = [
    { speaker: 'Member 1', text: 'First message.' },
    { speaker: 'Member 2', text: 'Second message.' },
    { speaker: 'Member 1', text: QUESTION },
    { speaker: 'Member 2', text: 'Later message.' },
  ];

  it('reads the message being answered and the two before it, with the titles', () => {
    const about = aboutText({
      discussionTitle: 'Moon drift',
      content: { title: 'A Scroll title', summary: undefined },
      messages,
      focus: 3,
    });
    expect(about.split('\n')).toEqual(['Moon drift', 'A Scroll title', 'First message.', 'Second message.', QUESTION]);
  });

  it('reads the newest three when the ask points at no message', () => {
    const about = aboutText({ discussionTitle: undefined, content: undefined, messages });
    expect(about.split('\n')).toEqual(['Second message.', QUESTION, 'Later message.']);
  });

  it('leaves out what keep-out replaced, which says nothing about a subject', () => {
    const about = aboutText({
      discussionTitle: KEPT_OUT_TOPIC,
      content: undefined,
      messages: [{ speaker: 'Member 1', text: KEPT_OUT_MESSAGE }, { speaker: 'Member 2', text: QUESTION }],
      focus: 2,
    });
    expect(about).toBe(QUESTION);
  });
});

describe('the stretch of a stop a question is shown', () => {
  it('keeps a stop that fits whole', () => {
    expect(windowOf(DRIFT, QUESTION)).toBe(DRIFT);
  });

  it('takes consecutive sentences of a long stop around the one that fits the question best, within the limit', () => {
    const filler = Array.from({ length: 12 }, (_, index) => `Sentence number ${String(index + 1)} says nothing of interest here at all.`);
    const stop = [...filler, 'Scientists measure the drift of the moon with lasers.', ...filler].join(' ');
    expect(stop.length).toBeGreaterThan(GROUND_PASSAGE_CHARS);
    const window = windowOf(stop, QUESTION);
    expect(window.length).toBeLessThanOrEqual(GROUND_PASSAGE_CHARS);
    expect(window).toContain('Scientists measure the drift of the moon with lasers.');
    // The words are the stop's own, in order: a quote of them is in the stop.
    expect(stop).toContain(window);
  });
});

describe('the passages chosen for a question (D-298)', () => {
  const library = [
    source('00000000-0000-4000-8000-00000000000a', 'Tides', TIDES),
    source('00000000-0000-4000-8000-00000000000b', 'Drift', DRIFT),
    source('00000000-0000-4000-8000-00000000000c', 'Kettles', KETTLE),
  ];

  it('offers the passage that fits the question, under the handle e1, and not a passage about something else', () => {
    const chosen = chooseGround(library, QUESTION);
    expect(chosen).toEqual([
      {
        handle: 'e1',
        assetId: '00000000-0000-4000-8000-00000000000b',
        assetRevision: 1,
        blockId: 's1',
        text: DRIFT,
      },
    ]);
  });

  it('does not offer a passage that shares one word with the question', () => {
    // The tides passage shares only "moon" with the question, which is not enough to be about it.
    expect(chooseGround([library[0]!], QUESTION)).toEqual([]);
  });

  it('offers nothing when the question has no key word', () => {
    expect(chooseGround(library, 'Why? Is it so?')).toEqual([]);
    expect(chooseGround(library, '')).toEqual([]);
  });

  it('puts the best fit first, and breaks a tie by the library’s own order', () => {
    const near = 'Scientists know the moon is slowly drifting away from the planet because lasers show it.';
    const first = source('00000000-0000-4000-8000-0000000000a1', 'A', DRIFT);
    const second = source('00000000-0000-4000-8000-0000000000a2', 'B', near);
    const chosen = chooseGround([first, second], QUESTION);
    expect(chosen.map((passage) => [passage.handle, passage.assetId])).toEqual([
      ['e1', second.assetId],
      ['e2', first.assetId],
    ]);
    // The same library and the same words choose the same passages, which a redelivered job relies on.
    expect(chooseGround([first, second], QUESTION)).toEqual(chosen);
  });

  it('takes no more than two stops of one Scroll and no more than four in all', () => {
    const long = source('00000000-0000-4000-8000-0000000000b1', 'One long Scroll', DRIFT, DRIFT, DRIFT, DRIFT);
    expect(chooseGround([long], QUESTION)).toHaveLength(GROUND_MAX_PER_ASSET);
    const many = Array.from({ length: 7 }, (_, index) =>
      source(`00000000-0000-4000-8000-0000000000c${String(index)}`, `Scroll ${String(index)}`, DRIFT),
    );
    const chosen = chooseGround(many, QUESTION);
    expect(chosen).toHaveLength(GROUND_MAX_PASSAGES);
    expect(chosen.map((passage) => passage.handle)).toEqual(['e1', 'e2', 'e3', 'e4']);
  });
});

describe('the ground reader', () => {
  it('reads the topic’s Scrolls and chooses from them, and reads nothing for words with no subject', async () => {
    const read = vi.fn(() => Promise.resolve([source('00000000-0000-4000-8000-00000000000b', 'Drift', DRIFT)]));
    const readGround = makeReadGround(read);
    const topic = { kind: 'system', id: 'a-system' } as const;
    expect(await readGround(topic, '   ')).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(await readGround(topic, QUESTION)).toHaveLength(1);
    expect(read).toHaveBeenCalledWith(topic, 100);
  });
});
