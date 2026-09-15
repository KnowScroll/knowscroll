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

test('rejects a completed job attached to the keep event from another universe', async () => {
  const differentUniverse='90000000-0000-4000-8000-000000000001';
  const row={
    decision_id:journey.decisionId,decision_universe_id:journey.universeId,
    exposure_universe_id:journey.universeId,ledger_exposure_universe_id:journey.universeId,
    keep_universe_id:journey.universeId,trace_universe_id:journey.universeId,
    job_universe_id:differentUniverse,exposure_id:journey.exposure.exposureId,
    exposure_event_id:journey.exposure.eventId,ledger_exposure_id:journey.exposure.eventId,
    ledger_exposure_kind:'exposure',exposure_client_key:journey.exposure.clientExposureId,
    keep_event_id:journey.accepted.eventId,keep_kind:'keep',keep_client_key:journey.accepted.clientEventId,
    causation_id:journey.exposure.eventId
  };
  await assert.rejects(
    verifyPersistedJourney({query:async()=>({rows:[row]})} as never,journey),
    new RegExp(`Expected values to be strictly equal[\\s\\S]*${differentUniverse}`)
  );
});
