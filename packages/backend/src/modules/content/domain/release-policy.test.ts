import { describe, expect, it } from 'vitest';
import { CONCEPTS } from './concepts.js';
import {
  AUTO_RELEASE_HOLDS,
  POLICY_DECIDER_PREFIX,
  RELEASE_POLICY,
  assessRisk,
  categoriesOfText,
  categoriesOfTopic,
  decideAutoRelease,
  isCatalogueTopic,
  raiseRisk,
  releasesLeftToday,
  type AutoReleaseFacts,
} from './release-policy.js';
import { SENSITIVE_CATEGORIES, SENSITIVE_KEYWORDS, SENSITIVE_SYSTEMS } from './release-sensitive-data.js';

const ORDINARY_TEXT = 'Orrin leans in its orbit, so a beam from its star strikes the north at a low angle in winter.';

/** Facts of a Scroll the policy releases; each test spoils one. */
const releasable: AutoReleaseFacts = {
  assetStatus: 'held',
  topicId: 'earth.seasons',
  topicApproved: true,
  risk: { riskClass: 'ordinary', categories: [], reasons: [] },
  documentReadable: true,
  coverageMapped: true,
  answerCheck: 'passed',
  supportCheck: { kind: 'checked', verdict: 'passed' },
};

describe('the name of a policy decision', () => {
  it('is `policy:<name>`, fits the review row, and never looks like a person’s `cli:` decision', () => {
    expect(RELEASE_POLICY.decidedBy).toBe(`${POLICY_DECIDER_PREFIX}${RELEASE_POLICY.id}`);
    expect(RELEASE_POLICY.decidedBy.length).toBeLessThanOrEqual(64);
    expect(RELEASE_POLICY.decidedBy.startsWith('cli:')).toBe(false);
  });
});

describe('a risk class only goes up', () => {
  it('keeps the higher of the current class and a proposal, whichever way round they come', () => {
    expect(raiseRisk('ordinary', 'ordinary')).toBe('ordinary');
    expect(raiseRisk('ordinary', 'sensitive')).toBe('sensitive');
    expect(raiseRisk('sensitive', 'sensitive')).toBe('sensitive');
    expect(raiseRisk('sensitive', 'ordinary')).toBe('sensitive');
  });

  it('cannot be lowered by anything an assessment is given: a raise makes an ordinary Scroll sensitive and nothing makes a sensitive one ordinary', () => {
    const plain = { topicId: 'space.stars', text: ORDINARY_TEXT };
    expect(assessRisk({ ...plain, raised: [] })).toEqual({ riskClass: 'ordinary', categories: [], reasons: [] });
    expect(assessRisk({ ...plain, raised: ['safety'] })).toEqual({
      riskClass: 'sensitive',
      categories: ['safety'],
      reasons: ['proposal'],
    });
    // The catalogue's verdict on a topic stands however much is proposed for ordinary.
    const body = assessRisk({ topicId: 'human-body.immune-system', text: ORDINARY_TEXT, raised: [] });
    expect(body.riskClass).toBe('sensitive');
    expect(body.categories).toEqual(['medicine', 'health']);
    expect(body.reasons).toEqual(['catalogue']);
  });
});

describe('the catalogue topic', () => {
  it('knows a topic, and neither a system nor a facet nor anything else', () => {
    expect(isCatalogueTopic('space.stars')).toBe(true);
    expect(isCatalogueTopic('space')).toBe(false);
    expect(isCatalogueTopic('space.stars.fusion')).toBe(false);
    expect(isCatalogueTopic('space.star')).toBe(false);
    expect(isCatalogueTopic('')).toBe(false);
  });

  it('puts every topic of Human body and of History in a sensitive category and no topic of the other systems', () => {
    for (const concept of CONCEPTS.filter((entry) => entry.parent !== null)) {
      const denied = concept.parent === 'human-body' || concept.parent === 'history';
      expect(categoriesOfTopic(concept.id).length > 0, concept.id).toBe(denied);
    }
    expect(categoriesOfTopic('human-body.heart-and-blood')).toEqual(['medicine', 'health']);
    expect(categoriesOfTopic('history.industrial-revolution')).toEqual(['political_history', 'religious_history']);
  });

  it('makes a decision for every system of the catalogue: a system added to the plan fails here until the owner says whether it is sensitive', () => {
    const decidedOrdinary = ['earth', 'space', 'machine-learning', 'computing'];
    const systems = CONCEPTS.filter((concept) => concept.parent === null).map((concept) => concept.id);
    for (const system of systems)
      expect(system in SENSITIVE_SYSTEMS || decidedOrdinary.includes(system), system).toBe(true);
    // And the data file names no system the plan does not hold.
    for (const system of Object.keys(SENSITIVE_SYSTEMS)) expect(systems, system).toContain(system);
  });

  it('is unknown for an id the catalogue does not hold, which the assessment treats as sensitive', () => {
    expect(categoriesOfTopic('astrology.signs')).toEqual([]);
    expect(assessRisk({ topicId: 'astrology.signs', text: ORDINARY_TEXT, raised: [] })).toEqual({
      riskClass: 'sensitive',
      categories: [],
      reasons: ['unknown_topic'],
    });
  });
});

describe('the words of a Scroll', () => {
  it('match whole words of the data file by category, ignoring case, with stems and phrases', () => {
    expect(categoriesOfText('Ask your doctor about the dosage.')).toEqual(['medicine']);
    expect(categoriesOfText('A VACCINATION programme.')).toEqual(['medicine']);
    expect(categoriesOfText('Where to invest your savings: the stock market.')).toEqual(['finance']);
    expect(categoriesOfText('Is it legal? The court decided.')).toEqual(['law']);
    expect(categoriesOfText('After the election, the government fell.')).toEqual(['political_history']);
    expect(categoriesOfText('Pilgrims and the church; God’s will.')).toEqual(['religious_history']);
    expect(categoriesOfText('Always follow the safety rules; the poison is toxic.')).toEqual(['safety']);
    expect(categoriesOfText('Breaking news from this week.')).toEqual(['current_events']);
    expect(categoriesOfText('Do not attempt this: it is dangerous.')).toEqual(['safety']);
  });

  it('match every category in the data file, so a list cannot be emptied unnoticed', () => {
    for (const category of SENSITIVE_CATEGORIES) {
      expect(SENSITIVE_KEYWORDS[category].length, category).toBeGreaterThan(5);
      for (const entry of SENSITIVE_KEYWORDS[category]) {
        const word = entry.endsWith('*') ? `${entry.slice(0, -1)}x` : entry;
        expect(categoriesOfText(`A line about ${word} and nothing else.`), entry).toContain(category);
      }
    }
  });

  it('do not match inside a longer word, and leave the ordinary words of the sciences alone', () => {
    expect(categoriesOfText('The planet’s revolution around its star takes a year.')).toEqual([]);
    expect(categoriesOfText('A monkey saw the emergence of a supernova explosion.')).toEqual([]);
    expect(categoriesOfText('The godfather of the dogwood and the doctorate.')).toEqual([]);
    expect(categoriesOfText('A bonded pair; a courtyard; a lawn; a patentee; a statue.')).toEqual([]);
    expect(categoriesOfText(ORDINARY_TEXT)).toEqual([]);
  });

  it('read a year from the recent range as current events, and no other number', () => {
    expect(categoriesOfText('The telescope launched in 2023.')).toEqual(['current_events']);
    expect(categoriesOfText('Warming by 2100 may reach two degrees.')).toEqual(['current_events']);
    expect(categoriesOfText('The comet of 1910 and the eclipse of 2022.')).toEqual([]);
    expect(categoriesOfText('A star of 2500 kelvin; a distance of 12,2024 metres; 20231 stars.')).toEqual([]);
  });
});

describe('whether the policy may release a Scroll', () => {
  it('releases a new Scroll in an approved topic that is ordinary, readable, mapped, answer-checked and supported', () => {
    expect(decideAutoRelease(releasable)).toEqual({ kind: 'release' });
  });

  const holds: readonly (readonly [string, Partial<AutoReleaseFacts>])[] = [
    ['replaces_served', { assetStatus: 'admitted' }],
    ['replaces_served', { assetStatus: 'withdrawn' }],
    ['no_topic', { topicId: null }],
    ['sensitive', { risk: { riskClass: 'sensitive', categories: ['health'], reasons: ['catalogue'] } }],
    ['topic_not_approved', { topicApproved: false }],
    ['unreadable', { documentReadable: false }],
    ['unmapped', { coverageMapped: false }],
    ['answer_check_not_passed', { answerCheck: 'repaired' }],
    ['answer_check_not_passed', { answerCheck: 'unchecked' }],
    ['answer_check_not_passed', { answerCheck: 'flagged' }],
    ['answer_check_not_passed', { answerCheck: 'none' }],
    ['no_support_check', { supportCheck: { kind: 'none' } }],
    ['stale_support_check', { supportCheck: { kind: 'stale' } }],
    ['support_unchecked', { supportCheck: { kind: 'unchecked' } }],
    ['support_flagged', { supportCheck: { kind: 'checked', verdict: 'flagged' } }],
  ];

  it.each(holds)('holds with %s', (reason, spoil) => {
    expect(decideAutoRelease({ ...releasable, ...spoil })).toEqual({ kind: 'hold', reason });
  });

  it('has a test for every code it can hold with', () => {
    expect(new Set(holds.map(([reason]) => reason))).toEqual(new Set(AUTO_RELEASE_HOLDS));
  });

  it('names a sensitive topic as sensitive even when nobody approved it, and holds a replacement before anything else', () => {
    const sensitive = { riskClass: 'sensitive', categories: ['law'], reasons: ['keyword'] } as const;
    expect(decideAutoRelease({ ...releasable, risk: sensitive, topicApproved: false })).toEqual({
      kind: 'hold',
      reason: 'sensitive',
    });
    expect(decideAutoRelease({ ...releasable, assetStatus: 'admitted', risk: sensitive })).toEqual({
      kind: 'hold',
      reason: 'replaces_served',
    });
  });
});

describe('the day’s cap', () => {
  it('leaves what is below the cap, and nothing at or over it', () => {
    expect(releasesLeftToday(5, 0)).toBe(5);
    expect(releasesLeftToday(5, 4)).toBe(1);
    expect(releasesLeftToday(5, 5)).toBe(0);
    expect(releasesLeftToday(5, 9)).toBe(0);
  });
});
