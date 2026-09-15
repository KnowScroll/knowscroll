import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyPersistedJourney, type HttpJourney} from './journey-verifier.ts';

const journey: HttpJourney = {
  universeId: '00000000-0000-4000-8000-000000000001',
  asset: {assetId: '10000000-0000-4000-8000-000000000001', revision: 1, sourceTitle: 'Source', sourceUrl: 'https://example.test/source', truthState: 'documented'},
  decisionId: '20000000-0000-4000-8000-000000000001',
  accountRevision: 0,
  exposure: {exposureId: '30000000-0000-4000-8000-000000000001', eventId: '40000000-0000-4000-8000-000000000001', clientExposureId: '70000000-0000-4000-8000-000000000001'},
  accepted: {eventId: '50000000-0000-4000-8000-000000000001', jobId: '60000000-0000-4000-8000-000000000001', status: 'accepted', clientEventId: '80000000-0000-4000-8000-000000000001'},
  beforeRevision: 0,
  afterRevision: 1
};

test('rejects plausible HTTP identifiers when verifier queries the wrong runtime database', async () => {
  const plausibleButWrongDatabase = {query: async () => ({rows: []})};
  await assert.rejects(
    verifyPersistedJourney(plausibleButWrongDatabase as never, journey),
    /no single persisted decision\/exposure\/keep\/job\/Accounts\/Trace lineage/
  );
});
