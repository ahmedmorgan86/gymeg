import {isFirestorePersistence,getFirestoreDb} from './firestore-db.ts';
import {withScope} from './database.ts';
import {firestoreBackend,postgresBackend,type SliceBackend} from './workspace-slice.ts';
let pg:SliceBackend|undefined,fs:SliceBackend|undefined;
/** Firestore slices need the composite indexes in firestore.indexes.json; until FIRESTORE_SLICE_INDEXES=1 they read the full state. */
/** Backend for the configured data layer (Firestore when configured, else Postgres). */
export function sliceBackend():SliceBackend{
  if(isFirestorePersistence())return fs??=firestoreBackend(getFirestoreDb as never,{indexed:process.env.FIRESTORE_SLICE_INDEXES==='1'});
  return pg??=postgresBackend(withScope as never);
}
