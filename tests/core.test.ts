import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankSignalCandidates,type ComposerPolicy,type SignalCandidate} from '../packages/core/src/composer.ts';
import {exposureInput,interactionInput,type ScrollAsset} from '../packages/contracts/src/index.ts';
const asset={assetId:'10000000-0000-4000-8000-000000000001',revision:1,kind:'Scroll',title:'A',summary:'B',body:'C',sourceTitle:'NASA',sourceUrl:'https://science.nasa.gov',truthState:'documented'} as ScrollAsset;
const policy: ComposerPolicy = {version:'test-policy',weights:{unreadBonus:100,exposurePenalty:10,recencyBonus:1},slateSize:3,maxPerSource:2};
const templates = {composer_unread:'Unread from {{sourceTitle}}.',composer_resurfaced:'From {{sourceTitle}}: {{exposureCount}} time(s), {{recencyDays}} day(s) ago.'};
const unreadCandidate: SignalCandidate = {asset,sourceKey:asset.sourceUrl,sourceTitle:asset.sourceTitle,exposureCount:0,lastExposedAtMs:null};
test('explicit keeps exclude an item without inferring interest',()=>{
  assert.equal(rankSignalCandidates([unreadCandidate],[],policy,templates,Date.now()).length,1);
  assert.deepEqual(rankSignalCandidates([unreadCandidate],[asset.assetId],policy,templates,Date.now()),[]);
});
test('closed admission rejects invented behavioral labels and missing exposure',()=>{assert.equal(interactionInput.safeParse({kind:'learned',assetId:asset.assetId}).success,false);assert.equal(exposureInput.safeParse({assetId:asset.assetId}).success,false);});
