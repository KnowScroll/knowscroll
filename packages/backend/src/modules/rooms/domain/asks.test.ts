import { describe, expect, it } from 'vitest';
import { DEFAULT_CAST } from './cast.js';
import { asksSomething, mentionedResident, pointedKind, residentForAsk } from './asks.js';

describe('which resident an ask is for', () => {
  it('sends a challenge or the other side to the Skeptic and a question about a message to the Explainer', () => {
    expect(residentForAsk('challenge')).toBe('skeptic');
    expect(residentForAsk('other_side')).toBe('skeptic');
    expect(residentForAsk('about')).toBe('explainer');
  });

  it('calls a plain ask and an unprompted turn not pointed at a message', () => {
    expect(pointedKind('ask')).toBeUndefined();
    expect(pointedKind(null)).toBeUndefined();
    expect(pointedKind('challenge')).toBe('challenge');
    expect(pointedKind('mention')).toBe('mention');
  });
});

describe('mentionedResident', () => {
  it('finds a resident named after an @, in any case', () => {
    expect(mentionedResident('@Nova what is a red giant?', DEFAULT_CAST)).toBe('explainer');
    expect(mentionedResident('is that right, @halley?', DEFAULT_CAST)).toBe('skeptic');
    expect(mentionedResident('(@HALLEY)', DEFAULT_CAST)).toBe('skeptic');
  });

  it('asks the first resident named when two are', () => {
    expect(mentionedResident('@Halley and @Nova, both of you', DEFAULT_CAST)).toBe('skeptic');
  });

  it('names no one for an address, a longer word or a name the room does not have', () => {
    expect(mentionedResident('write to asha@nova.example', DEFAULT_CAST)).toBeUndefined();
    expect(mentionedResident('@Novae are exploding stars', DEFAULT_CAST)).toBeUndefined();
    expect(mentionedResident('@Pixel start the quiz', DEFAULT_CAST)).toBeUndefined();
    expect(mentionedResident('Nova without an at sign', DEFAULT_CAST)).toBeUndefined();
    expect(mentionedResident('@Nova', [])).toBeUndefined();
  });

  it('takes the names from the room cast, escaping anything odd in them', () => {
    const cast = [
      { inhabitant: 'explainer', name: 'N.va' },
      { inhabitant: 'skeptic', name: 'Hal(ley' },
    ] as const;
    expect(mentionedResident('@N.va hello', cast)).toBe('explainer');
    expect(mentionedResident('@Nova hello', cast)).toBeUndefined();
    expect(mentionedResident('@Hal(ley hello', cast)).toBe('skeptic');
  });
});

describe('asksSomething', () => {
  it('is true for a question mark anywhere, an interrogative opening and a request verb, whatever the @name or the greeting', () => {
    expect(asksSomething('@Nova what is a spring tide?')).toBe(true);
    expect(asksSomething('@Nova why is the sky blue')).toBe(true);
    expect(asksSomething('hi @Nova, how do tides work')).toBe(true);
    expect(asksSomething('@Halley is that so')).toBe(true);
    expect(asksSomething('@Nova explain the far-side bulge')).toBe(true);
    expect(asksSomething('Please tell me about the Moon @Nova')).toBe(true);
    expect(asksSomething('thanks @Nova, but wait? is it so')).toBe(true);
  });

  it('is false for a greeting, thanks or a bare @name', () => {
    for (const text of [
      '@Nova',
      'hi @Halley',
      '@Nova thanks, that helps',
      'Thank you so much @Nova!',
      '@Halley nice one',
      'great, thanks @Nova',
      '@Nova @Halley good morning',
    ])
      expect(asksSomething(text)).toBe(false);
  });
});
