import {
  countSteps,
  namesOldRevision,
  runSteps,
  type ModuleRemovalReport,
  type OldScrollRemoval,
  type RemovalStep,
} from '../../../infrastructure/erasure/index.js';

/**
 * What Feedback does when the Scrolls of the retired document formats leave the database (`content cleanup-old-scrolls`, #791,
 * D-437). A report about a Scroll names its revision by a foreign key, and selective Clear keeps reports (a report is a message to
 * the safety team, not exploration evidence). A report about a Scroll that no longer exists has nothing to be about, so it is deleted.
 * A report about a person, a message or a Reel is never touched.
 */
const feedbackSteps = (): readonly RemovalStep[] => [
  { table: 'feedback.reports', action: 'delete', where: namesOldRevision('t', 'asset_id', 'asset_revision') },
];

/** Feedback's part of the cleanup. */
export const feedbackOldScrollRemoval: OldScrollRemoval = {
  module: 'feedback',
  async count(trx): Promise<ModuleRemovalReport> {
    return { tables: await countSteps(trx, feedbackSteps()) };
  },
  async run(trx): Promise<ModuleRemovalReport> {
    return { tables: await runSteps(trx, feedbackSteps()) };
  },
};
