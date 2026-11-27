import { systemsInCommon } from './in-common';

const friend = (...labels: string[]) => labels.map((label, at) => ({ label, publicSystemId: `s${String(at)}` }));
const idsOf = (systems: readonly { publicSystemId: string }[]) => systems.map((system) => system.publicSystemId);

describe('systemsInCommon', () => {
  it('returns the friend’s systems you also have, in the friend’s order', () => {
    const shared = systemsInCommon(['Stars', 'Attention', 'Baking'], friend('Attention', 'Tides', 'Stars'));
    expect(shared.map((system) => system.label)).toEqual(['Attention', 'Stars']);
    expect(idsOf(shared)).toEqual(['s0', 's2']);
  });

  it('ignores case', () => {
    expect(idsOf(systemsInCommon(['machine LEARNING'], friend('Machine Learning')))).toEqual(['s0']);
  });

  it('ignores accents, whichever side carries them', () => {
    expect(idsOf(systemsInCommon(['Café'], friend('CAFE', 'Naïve art')))).toEqual(['s0']);
    expect(idsOf(systemsInCommon(['cafe', 'naive ART'], friend('Café', 'Naïve art')))).toEqual(['s0', 's1']);
  });

  it('treats runs of spaces as one and ignores the ends', () => {
    expect(idsOf(systemsInCommon(['  Machine   learning '], friend('Machine learning')))).toEqual(['s0']);
  });

  it('does not match part of a name', () => {
    expect(systemsInCommon(['Machine learning'], friend('Machine', 'Learning', 'Machine learning basics'))).toEqual([]);
  });

  it('returns each of a friend’s systems that shares a name, and counts your duplicates once', () => {
    expect(idsOf(systemsInCommon(['Baking', 'baking', 'BAKING'], friend('Baking', 'Tides', 'baking')))).toEqual([
      's0',
      's2',
    ]);
  });

  it('finds nothing when either side is empty', () => {
    expect(systemsInCommon([], friend('Stars'))).toEqual([]);
    expect(systemsInCommon(['Stars'], [])).toEqual([]);
    expect(systemsInCommon([], [])).toEqual([]);
  });

  it('never matches a name that is blank once folded', () => {
    expect(systemsInCommon(['', ' ', '́'], friend('', '  ', '́'))).toEqual([]);
  });

  it('does not change what it is given', () => {
    const own = ['Stars'];
    const theirs = friend('Stars');
    systemsInCommon(own, theirs);
    expect(own).toEqual(['Stars']);
    expect(theirs).toEqual(friend('Stars'));
  });
});
