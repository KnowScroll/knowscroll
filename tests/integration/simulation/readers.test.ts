import { defineLab } from './lab.js';
import { broadSkimmer, coldStartExplorer, idleTab, linkReaderReels, pauseResume, reelWatcher } from './personas.js';

/**
 * The readers who mostly browse: someone with no history, a hopper who skims across every topic, a Reel watcher, a reader
 * who follows two links to Reels of one system, an idle tab left open for hours, and a person who pauses recording and
 * resumes. All on the full fixture library.
 */
defineLab({
  group: 'readers',
  solo: [coldStartExplorer, broadSkimmer, reelWatcher, linkReaderReels, idleTab, pauseResume],
});
