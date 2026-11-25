import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('support alert call sites are the authenticated session actions', () => {
  const route = readFileSync(new URL('../app/api/commercial/route.ts', import.meta.url), 'utf8');
  assert.match(route, /await commercialTransaction\(user,\(c,p\)=>endSupport.*?if\(result\.ended\)await sendSupportFcm\(user\.userId,'ended'\)/s);
  assert.match(route, /await commercialTransaction\(user,\(c,p\)=>startSupport.*?await sendSupportFcm\(user\.userId,'started'\)/s);
});
