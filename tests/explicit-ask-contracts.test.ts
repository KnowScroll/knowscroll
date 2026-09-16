import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import {explicitAskInput} from '../packages/contracts/src/index.ts';

test('explicit Ask input preserves literal valid text and rejects invalid source text',()=>{
 const clientAskId=randomUUID().toUpperCase(),exposureId=randomUUID().toUpperCase();
 const literal='  Why did this happen?  ';
 const parsed=explicitAskInput.parse({clientAskId,exposureId,expectedPrivacyEpoch:0,question:literal});
 assert.equal(parsed.clientAskId,clientAskId.toLowerCase());
 assert.equal(parsed.exposureId,exposureId.toLowerCase());
 assert.equal(parsed.question,literal);

 for(const question of ['', '   ', '\t', '\n', '\u00a0', '\u2003', '\0', '\ud800']) {
  assert.equal(explicitAskInput.safeParse({clientAskId,exposureId,expectedPrivacyEpoch:0,question}).success,false,JSON.stringify(question));
 }
 assert.equal(explicitAskInput.safeParse({clientAskId,exposureId,expectedPrivacyEpoch:0,question:'x'.repeat(4096)}).success,true);
 assert.equal(explicitAskInput.safeParse({clientAskId,exposureId,expectedPrivacyEpoch:0,question:'é'.repeat(2049)}).success,false);
});
