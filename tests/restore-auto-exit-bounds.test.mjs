import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyState} from '../app/lib/domain.ts';
import {validateBackup} from '../app/lib/backup.ts';
// SQL auto-exit clamps autoExitMinutes to 1..1440; restore admission must never admit a value outside that range.
const base=()=>JSON.parse(JSON.stringify(emptyState()));
const withMinutes=n=>{const s=base();s.settings.reception={autoExitMinutes:n,warningDays:3,blockDebt:false};return s;};
test('restore accepts autoExitMinutes 1 and 1440',()=>{for(const n of [1,1440])assert.equal(validateBackup(withMinutes(n)).settings.reception.autoExitMinutes,n);});
test('restore rejects autoExitMinutes 0, 1441, 1.5, NaN-like and strings',()=>{
  for(const n of [0,1441,1.5,-1,'60',null])assert.throws(()=>validateBackup(withMinutes(n)),undefined,String(n));
});
