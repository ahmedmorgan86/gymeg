import assert from 'node:assert/strict';
import {test} from 'node:test';
import {coreStateBytes,envelopeStateBytes,PHOTO_TOTAL_BYTE_LIMIT} from '../app/lib/photo-budget.ts';
import {STATE_BYTE_LIMIT} from '../app/lib/workspace-slice.ts';

const utf8=s=>new TextEncoder().encode(s).length;
const state=photos=>({members:photos.map((p,i)=>({id:'m'+i,photo:p}))});

test('coreStateBytes excludes member photo bodies, keeps everything else',()=>{
 const photo='data:image/jpeg;base64,/9j/'+'A'.repeat(96000-27);
 const withPhotos=state([photo,photo,undefined]);
 const without=state([undefined,undefined,undefined]);
 const measured=coreStateBytes(withPhotos);
 const exactCore=utf8(JSON.stringify(without));
 // Photo bodies excluded: measured is within per-photo JSON overhead of the exact core size.
 assert.ok(measured>=exactCore,'never undercounts the core');
 assert.ok(measured-exactCore<200,'only small per-photo field overhead remains');
 // The same state with photos would otherwise count 2*96,000 chars toward the envelope.
 assert.ok(utf8(JSON.stringify(withPhotos))-measured>=2*96000);
});

test('photo budget vs core envelope: 209 max-size photos fit the photo budget, not the core envelope',()=>{
 assert.ok(209*96000>STATE_BYTE_LIMIT,'reviewer 209-photo counterexample exceeds the core envelope');
 assert.ok(209*96000<PHOTO_TOTAL_BYTE_LIMIT,'and fits the separate photo budget');
 assert.ok(STATE_BYTE_LIMIT+PHOTO_TOTAL_BYTE_LIMIT<64*1024*1024,'worst backup stays under BACKUP_MAX_BYTES');
});

test('envelopeStateBytes: photos counted on inline backends, excluded when separated',()=>{
 const photo='data:image/jpeg;base64,/9j/'+'A'.repeat(96000-27);
 const s=state([photo]);
 assert.equal(envelopeStateBytes(s,false),utf8(JSON.stringify(s)),'inline backend keeps legacy full measurement');
 assert.equal(envelopeStateBytes(s,true),coreStateBytes(s));
 assert.ok(envelopeStateBytes(s,false)-envelopeStateBytes(s,true)>=96000);
});
