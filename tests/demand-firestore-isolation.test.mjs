import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {firestoreBackend} from '../app/lib/workspace-slice.ts';

// Firestore isolation of the demand-loading routes. Static and behavioural:
// the Firestore slice backend can never "open" a bounded Postgres read, and
// every demand route is default-off and returns 501 on that backend BEFORE
// it opens a database scope. This is source-level evidence, not a live
// Firestore deployment test.
const base=new URL('../app/api/workspace/',import.meta.url);

test('Firestore slice backend never supports bounded Postgres reads and touches no database to say so',()=>{
 const be=firestoreBackend(()=>{throw Error('database must not be touched');},{indexed:true});
 assert.equal(be.supportsOpen,false);
 assert.equal(firestoreBackend(()=>{throw Error('x');},{indexed:false}).supportsOpen,false);
});

test('every demand route is default-off and fails closed on a non-open backend before any scope or read',()=>{
 const routes=readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory()&&existsSync(new URL(d.name+'/route.ts',base))).map(d=>d.name);
 assert.ok(routes.length>=12);
 const exempt=new Set(['changes']); // pre-existing route with its own explicit Firestore branch (checked below)
 for(const name of routes){
  const src=readFileSync(new URL(name+'/route.ts',base),'utf8');
  if(exempt.has(name)){assert.match(src,/isFirestorePersistence\(\)/,name+' keeps its explicit Firestore branch');continue;}
  const flag=src.search(/process\.env\.GYMOS_[A-Z_]+!=='1'/),guard=src.search(/!be\.supportsOpen/),scope=src.search(/withScope\(|readSpaceMeta\(/);
  assert.ok(flag>=0,name+': default-off flag gate present');
  assert.ok(guard>=0,name+': supportsOpen guard present');
  assert.ok(scope>=0,name+': a database scope or read exists to be ordered against');
  assert.ok(flag<guard,name+': flag gate precedes the supportsOpen guard');
  assert.ok(guard<scope,name+': supportsOpen guard precedes the first database scope or read');
  assert.match(src,/reply\(\{error:["']unsupported["']\},501\)/,name+': 501 unsupported');
 }
});
