import { describe, expect, it } from 'vitest';
import { PICTURE_KINDS, SCROLL_SHAPES } from '@knowscroll/scroll-model';
import { PICTURE_KIND_IDS, SCROLL_SHAPE_IDS } from '../../domain/library/plan.js';
import { TOPICS } from '../topics.js';
import { parseSpikeArms, parseSpikeTopicsV3, SPIKE_TOPICS_V3, spikePlanV3 } from './plans.js';

describe('the plan table of the v3 spike', () => {
  it('names the ten recipes of the spike, each a library recipe with a brief and pages of its own', () => {
    expect(SPIKE_TOPICS_V3).toEqual([
      'seasons',
      'tides-spring-neap',
      'greenhouse-radiation',
      'cardiac-cycle',
      'black-hole-formation',
      'gradient-descent',
      'dns-lookup',
      'industrial-causes',
      'immune-memory',
      'exoplanet-kinds',
    ]);
    for (const key of SPIKE_TOPICS_V3) {
      expect(Object.hasOwn(TOPICS, key), key).toBe(true);
      expect(TOPICS[key].brief.length, key).toBeGreaterThan(0);
      expect(TOPICS[key].pages.length, key).toBeGreaterThan(0);
    }
  });

  it('has three sections and no misconception for every recipe', () => {
    for (const key of SPIKE_TOPICS_V3) {
      expect(spikePlanV3(key).sections, key).toHaveLength(3);
      expect(spikePlanV3(key).misconception, key).toEqual({ kind: 'none' });
    }
  });

  it('names pictures for the five recipes a kit once drew, and leaves the other five to the writer', () => {
    const named = SPIKE_TOPICS_V3.filter((key) => spikePlanV3(key).pictures !== undefined);
    expect(named).toEqual([
      'seasons',
      'tides-spring-neap',
      'greenhouse-radiation',
      'cardiac-cycle',
      'black-hole-formation',
    ]);
    expect(spikePlanV3('seasons').pictures?.map((picture) => picture.kind)).toEqual(['statement', 'grid']);
    expect(spikePlanV3('tides-spring-neap').pictures?.map((picture) => picture.kind)).toEqual(['cycle']);
    expect(spikePlanV3('greenhouse-radiation').pictures?.map((picture) => picture.kind)).toEqual(['flow', 'flow']);
    expect(spikePlanV3('cardiac-cycle').pictures?.map((picture) => picture.kind)).toEqual(['cycle', 'grid']);
    expect(spikePlanV3('black-hole-formation').pictures?.map((picture) => picture.kind)).toEqual(['flow', 'grid']);
  });

  it('gives each shape the table asks for', () => {
    expect(SPIKE_TOPICS_V3.map((key) => spikePlanV3(key).shape)).toEqual([
      'argument',
      'mechanism',
      'mechanism',
      'mechanism',
      'story',
      'mechanism',
      'mechanism',
      'argument',
      'mechanism',
      'argument',
    ]);
  });

  it('uses the kinds and shapes of the document, so a plan the writer reads is one the compile can check', () => {
    expect([...PICTURE_KIND_IDS]).toEqual([...PICTURE_KINDS]);
    expect([...SCROLL_SHAPE_IDS]).toEqual([...SCROLL_SHAPES]);
  });
});

describe('the options of the command', () => {
  it('reads recipe keys of the table only, repeats dropped', () => {
    expect(parseSpikeTopicsV3('seasons, dns-lookup,seasons')).toEqual(['seasons', 'dns-lookup']);
    expect(parseSpikeTopicsV3('seasons,tides')).toBeUndefined();
    expect(parseSpikeTopicsV3('')).toBeUndefined();
  });

  it('reads the arms a and b', () => {
    expect(parseSpikeArms('a,b')).toEqual(['a', 'b']);
    expect(parseSpikeArms('b')).toEqual(['b']);
    expect(parseSpikeArms('a,a')).toEqual(['a']);
    expect(parseSpikeArms('c')).toBeUndefined();
    expect(parseSpikeArms('')).toBeUndefined();
  });
});
