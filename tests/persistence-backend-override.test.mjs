import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import {isFirebaseConfigured,isFirestorePersistence} from '../app/lib/firestore-db.ts';

const FIREBASE_ENV=['GYMEG_FIREBASE_SERVICE_ACCOUNT','GYMEG_FIREBASE_PROJECT_ID','FIREBASE_PROJECT_ID','NEXT_PUBLIC_FIREBASE_PROJECT_ID'];
function withEnv(env,fn){
  const saved={};
  for(const k of [...FIREBASE_ENV,'GYMOS_DATA_BACKEND']){saved[k]=process.env[k];delete process.env[k];}
  Object.assign(process.env,env);
  try{return fn();}
  finally{for(const k of Object.keys(saved)){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
}

test('persistence backend selector follows GYMOS_DATA_BACKEND independently of Firebase auth env',()=>{
  withEnv({},()=>{
    assert.equal(isFirebaseConfigured(),false);
    assert.equal(isFirestorePersistence(),false);
  });
  withEnv({GYMEG_FIREBASE_SERVICE_ACCOUNT:'{}'},()=>{
    assert.equal(isFirebaseConfigured(),true);
    assert.equal(isFirestorePersistence(),true);
  });
  withEnv({FIREBASE_PROJECT_ID:'proj'},()=>{
    assert.equal(isFirestorePersistence(),true);
  });
  // Mixed mode: Firebase stays configured for auth/push while data lives in Postgres.
  withEnv({GYMEG_FIREBASE_SERVICE_ACCOUNT:'{}',GYMOS_DATA_BACKEND:'postgres'},()=>{
    assert.equal(isFirebaseConfigured(),true);
    assert.equal(isFirestorePersistence(),false);
  });
  // Explicit unknown values fail closed: no silent fallback to either backend.
  for (const bad of ['firestore','postgrs','POSTGRES','sqlite']) {
    withEnv({GYMEG_FIREBASE_SERVICE_ACCOUNT:'{}',GYMOS_DATA_BACKEND:bad},()=>{
      assert.throws(()=>isFirestorePersistence(),/GYMOS_DATA_BACKEND/);
    });
    withEnv({GYMOS_DATA_BACKEND:bad},()=>{
      assert.throws(()=>isFirestorePersistence(),/GYMOS_DATA_BACKEND/);
    });
  }
  // Empty string behaves as unset (legacy).
  withEnv({GYMEG_FIREBASE_SERVICE_ACCOUNT:'{}',GYMOS_DATA_BACKEND:''},()=>{
    assert.equal(isFirestorePersistence(),true);
  });
});

test('only auth-provider code keeps calling isFirebaseConfigured; data paths use the persistence selector',()=>{
  const files=[];
  const roots=['app','components','hooks','lib','scripts'];
  const walk=dir=>{for(const name of readdirSync(dir)){const p=join(dir,name);if(statSync(p).isDirectory())walk(p);else if(/\.(ts|tsx|mjs)$/.test(p))files.push(p);}};
  for(const root of roots){const abs=join(import.meta.dirname,'..',root);try{walk(abs);}catch{/* root absent */}}
  const allowed=new Set([
    join('app','lib','firebase-server-auth.ts'), // Firebase Auth provider (session, sign-in, OAuth)
    join('app','lib','firestore-db.ts'),   // predicate definitions
    join('app','lib','auth-rate-limit.ts'),// comment reference only
  ]);
  const offenders=[];
  for(const p of files){
    if(allowed.has(relative(join(import.meta.dirname,'..'),p)))continue;
    const src=readFileSync(p,'utf8');
    // strip line comments before scanning
    const code=src.split('\n').map(l=>{const i=l.indexOf('//');return i<0?l:l.slice(0,i);}).join('\n');
    if(/\bisFirebaseConfigured\s*\(/.test(code))offenders.push(p);
  }
  assert.deepEqual(offenders,[],`data-path files still calling isFirebaseConfigured(): ${offenders.join(', ')}`);
});
