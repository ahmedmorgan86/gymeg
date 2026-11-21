// Run only on a trusted administrative machine after the intended owner has
// registered and verified their Firebase Authentication email address.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const uid = process.argv[2];
const raw = process.env.GYMEG_FIREBASE_SERVICE_ACCOUNT;
if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !raw) throw Error('Usage: GYMEG_FIREBASE_SERVICE_ACCOUNT=... node scripts/firebase-bootstrap-admin.mjs <verified-firebase-uid>');
const account = JSON.parse(raw);
if (!account.project_id || !account.private_key || !account.client_email) throw Error('Invalid service account');
initializeApp({ credential: cert(account), projectId: account.project_id });
const user = await getAuth().getUser(uid);
if (!user.emailVerified || user.disabled) throw Error('The Firebase user must be enabled and email verified');
await getFirestore().collection('platform_admins').doc(uid).create({ user_id: uid, active: true, created_at: new Date().toISOString() });
console.log(`Platform administrator created for verified Firebase UID ${uid}`);
