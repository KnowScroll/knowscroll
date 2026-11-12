import { expect } from 'vitest';
import { defineLab } from './lab.js';
import {
  broadSkimmer,
  coldStartExplorer,
  idleTab,
  linkReaderReels,
  linkReaderReelsNearly,
  pauseResume,
  reelWatcher,
} from './personas.js';

/**
 * The readers who mostly browse: someone with no history, a hopper who skims across every topic, a Reel watcher, a reader
 * who follows two links to Reels of one system, an idle tab left open for hours, and a person who pauses recording and
 * resumes. All on the full fixture library. Two exact scenarios state their outcomes: two Reels watched to the end form a
 * system, and the same two watched to 85-95% (qualified, but short of the closing segment) do not.
 */
defineLab({
  group: 'readers',
  solo: [coldStartExplorer, broadSkimmer, reelWatcher, linkReaderReels, linkReaderReelsNearly, idleTab, pauseResume],
  outcomes: (results) => {
    const of = (id: string) => results.find((result) => result.run.spec.id === id)!;
    const systems = (id: string) => of(id).db.places.filter((key) => key.startsWith('system:'));
    const qualified = (id: string) =>
      of(id).run.encounters.filter((encounter) => encounter.qualification === 'qualified');
    // Watched to the end: both qualify and prove their facets, and the system forms.
    expect(qualified('link-reader-reels')).toHaveLength(2);
    expect(of('link-reader-reels').db.referencedExposures).toHaveLength(2);
    expect(systems('link-reader-reels')).toHaveLength(1);
    // Left at 85-95%: both qualify, the closing segment is unmet, so no reference, no trusted support and no system.
    expect(qualified('link-reader-reels-nearly')).toHaveLength(2);
    expect(of('link-reader-reels-nearly').db.referencedExposures).toEqual([]);
    expect(of('link-reader-reels-nearly').db.supportTopics).toEqual([]);
    expect(systems('link-reader-reels-nearly')).toEqual([]);
  },
});
