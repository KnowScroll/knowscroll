import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compose} from '../packages/core/src/composer.ts';
import {exposureInput,interactionInput,type ScrollAsset} from '../packages/contracts/src/index.ts';
const asset={assetId:'10000000-0000-4000-8000-000000000001',revision:1,kind:'Scroll',title:'A',summary:'B',body:'C',sourceTitle:'NASA',sourceUrl:'https://science.nasa.gov',truthState:'documented'} as ScrollAsset;
test('explicit keeps exclude an item without inferring interest',()=>{assert.equal(compose([asset],[]).length,1);assert.deepEqual(compose([asset],[asset.assetId]),[]);});
test('closed admission rejects invented behavioral labels and missing exposure',()=>{assert.equal(interactionInput.safeParse({kind:'learned',assetId:asset.assetId}).success,false);assert.equal(exposureInput.safeParse({assetId:asset.assetId}).success,false);});
