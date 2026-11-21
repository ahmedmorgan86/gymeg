import {useFirestorePersistence} from './firestore-db.ts';
import {firebasePlatform} from './firestore-commercial';
import {commercialTransaction} from './commercial';
import type {ChatGPTUser} from '../chatgpt-auth';

// Platform-admin authorization data lives with the rest of the gym data:
// Firestore only when Firestore is the persistence backend, Postgres
// (platform_admins via commercialTransaction) otherwise. A deployment that
// keeps Firebase envs solely for FCM push must authorize against Postgres.
export async function platformAuthority(user:ChatGPTUser){
  return useFirestorePersistence()?firebasePlatform(user):commercialTransaction(user,async(_client,platform)=>platform);
}
