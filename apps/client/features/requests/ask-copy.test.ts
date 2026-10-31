import { COUNTER_FROM, aboutTitle, usuallyPhrase } from './ask-copy';

describe('the words of the Ask sheet', () => {
  it('says a usual time only when there is one, in the words a person would use', () => {
    expect(usuallyPhrase(undefined)).toBeUndefined();
    expect(usuallyPhrase(40)).toBe('usually about a minute');
    expect(usuallyPhrase(89)).toBe('usually about a minute');
    expect(usuallyPhrase(90)).toBe('usually about 2 min');
    expect(usuallyPhrase(300)).toBe('usually about 5 min');
  });

  it('names the Scroll by the head of its title, cut at a word', () => {
    expect(aboutTitle('Why Earth has seasons: it leans')).toBe('Why Earth has seasons');
    expect(aboutTitle('Seasons')).toBe('Seasons');
    expect(aboutTitle('How a lighthouse guides ships through fog and over long dark coastlines')).toBe(
      'How a lighthouse guides ships…',
    );
  });

  it('shows a counter only near the 280-character limit', () => {
    expect(COUNTER_FROM).toBe(240);
  });
});
