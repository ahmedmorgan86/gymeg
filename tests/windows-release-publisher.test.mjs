import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseMetadata} from '../scripts/publish-windows-release.mjs';

test('Windows release metadata uses a stable versioned tag and asset name',()=>{
 assert.deepEqual(releaseMetadata('1.1.16'),{tag:'windows-1.1.16',name:'GymEG Windows x64 1.1.16',asset:'GymEG-Windows-x64-1.1.16.exe'});
});

test('Windows release publisher rejects malformed or ambiguous versions',()=>{
 for(const version of ['', '1.1', 'v1.1.16', '1.1.16-beta', '01.1.16', '1.1.16/other'])assert.throws(()=>releaseMetadata(version),/Invalid Windows release version/);
});
