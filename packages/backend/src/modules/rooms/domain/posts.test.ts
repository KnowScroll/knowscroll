import {
  ROOM_POST_TITLE_MAX_CHARS,
  ROOM_POST_WORDS_MAX_CHARS,
  ROOM_SOURCE_MAX_CHARS,
} from '@knowscroll/contracts';
import { describe, expect, it } from 'vitest';
import { POST_RULES, checkSource, hostOf, mayPost, postTextProblem } from './posts.js';

describe('the numbers a screen shows are the contract’s', () => {
  it('agree', () => {
    expect(POST_RULES.titleMaxChars).toBe(ROOM_POST_TITLE_MAX_CHARS);
    expect(POST_RULES.wordsMaxChars).toBe(ROOM_POST_WORDS_MAX_CHARS);
    expect(POST_RULES.sourceMaxChars).toBe(ROOM_SOURCE_MAX_CHARS);
  });
});

describe('the headline and the words of a post', () => {
  it('say something, fit, and carry no address', () => {
    expect(postTextProblem('A galaxy bends light', 80, false)).toBeUndefined();
    expect(postTextProblem('   ', 80, false)).toBe('empty');
    expect(postTextProblem('x'.repeat(81), 80, false)).toBe('too_long');
    expect(postTextProblem('Read https://example.com now', 500, true)).toBe('has_link');
    expect(postTextProblem('see www.example.com', 500, true)).toBe('has_link');
  });

  it('allow a line break in the words and not in the headline, and no other control', () => {
    expect(postTextProblem('one\ntwo', 500, true)).toBeUndefined();
    expect(postTextProblem('one\ntwo', 80, false)).toBe('has_control');
    expect(postTextProblem('one\u0007two', 500, true)).toBe('has_control');
  });

  it('count characters, not bytes', () => {
    expect(postTextProblem('é'.repeat(80), 80, false)).toBeUndefined();
    expect(postTextProblem('🪐'.repeat(80), 80, false)).toBeUndefined();
    expect(postTextProblem('🪐'.repeat(81), 80, false)).toBe('too_long');
  });
});

describe('a source (checked as text, never fetched)', () => {
  const ok = (input: string) => {
    const checked = checkSource(input);
    if (checked.kind !== 'ok') throw new Error(`refused: ${checked.problem}`);
    return checked.source;
  };
  const refused = (input: string) => {
    const checked = checkSource(input);
    return checked.kind === 'refused' ? checked.problem : 'accepted';
  };

  it('accepts the plain address of a page, http or https, and says the site’s name', () => {
    expect(ok('https://www.nature.com/articles/s41586-020-2649-2')).toEqual({
      url: 'https://www.nature.com/articles/s41586-020-2649-2',
      host: 'nature.com',
    });
    expect(ok('http://example.org/a?b=1').url).toBe('http://example.org/a?b=1');
    expect(ok('  https://en.wikipedia.org/wiki/Gravitational_lens  ').host).toBe('en.wikipedia.org');
  });

  it('makes one page one source: the fragment and tracking parameters go, the host is lower case', () => {
    expect(ok('HTTPS://Example.ORG/page?utm_source=x&id=7&fbclid=abc#section').url).toBe('https://example.org/page?id=7');
    expect(ok('https://example.org/page?utm_medium=x').url).toBe('https://example.org/page');
    expect(ok('https://example.org/page').url).toBe(ok('https://example.org/page#top').url);
  });

  it('refuses what is not an address, and what is not http or https', () => {
    expect(refused('')).toBe('empty');
    expect(refused('not a link')).toBe('not_an_address');
    expect(refused('example.com/page')).toBe('not_an_address');
    expect(refused('ftp://example.com/file')).toBe('not_http');
    expect(refused('javascript:alert(1)')).toBe('not_http');
    expect(refused('data:text/html,<b>x</b>')).toBe('not_http');
    expect(refused('https://example.com/a b')).toBe('not_an_address');
  });

  it('refuses an address with a sign-in or a port', () => {
    expect(refused('https://user:secret@example.com/')).toBe('has_credentials');
    expect(refused('https://user@example.com/')).toBe('has_credentials');
    expect(refused('https://example.com:8443/')).toBe('has_port');
  });

  it('refuses a machine’s number or an inside-network name: a source is a site', () => {
    expect(refused('http://127.0.0.1/admin')).toBe('not_a_site');
    expect(refused('http://2130706433/')).toBe('not_a_site');
    expect(refused('http://[::1]/')).toBe('not_a_site');
    expect(refused('http://localhost/')).toBe('not_a_site');
    expect(refused('http://printer.local/')).toBe('not_a_site');
    expect(refused('http://intranet/')).toBe('not_a_site');
    expect(refused('http://192.168.0.1/')).toBe('not_a_site');
  });

  it('refuses a link shortener, because it hides where the link goes', () => {
    expect(refused('https://bit.ly/3abc')).toBe('shortener');
    expect(refused('https://www.t.co/xyz')).toBe('shortener');
    expect(refused('https://tinyurl.com/abc')).toBe('shortener');
  });

  it('refuses an address longer than it keeps', () => {
    expect(refused(`https://example.com/${'a'.repeat(ROOM_SOURCE_MAX_CHARS)}`)).toBe('too_long');
  });

  it('takes an internationalised name as its plain form', () => {
    expect(ok('https://münchen.de/').host).toBe('xn--mnchen-3ya.de');
  });

  it('gives the host of a stored address', () => {
    expect(hostOf('https://www.Example.org/a')).toBe('example.org');
  });
});

describe('how many a member may post', () => {
  it('is three a room a day', () => {
    expect(POST_RULES.perDay).toBe(3);
    expect(mayPost(0)).toBe(true);
    expect(mayPost(2)).toBe(true);
    expect(mayPost(3)).toBe(false);
  });
});
