import {isFirebaseConfigured,getFirestoreDb} from './firestore-db.ts';
import {withScope} from './database.ts';
import {firestoreBackend,postgresBackend,type SliceBackend} from './workspace-slice.ts';
let pg:SliceBackend|undefined,fs:SliceBackend|undefined;
/** Backend for the configured data layer (Firestore when configured, else Postgres). */
export function sliceBackend():SliceBackend{
  if(isFirebaseConfigured())return fs??=firestoreBackend(getFirestoreDb as never);
  return pg??=postgresBackend(withScope as never);
}
