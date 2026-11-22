import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {getPool,withScope} from '../app/lib/database.ts';
import {isFirestorePersistence} from '../app/lib/firestore-db.ts';
import {readEntitySpace,persistSpace} from '../app/lib/entity-store.ts';
import {normalize} from '../app/lib/extensions.ts';
import {completeDemo,DEMO_PREFIX} from '../app/lib/complete-demo.ts';

// Seeds the fictional demo club into whichever backend the deployment uses:
// Firestore when it is the persistence backend, Postgres/Supabase otherwise.
// Follows isFirestorePersistence() so a deployment that keeps Firebase envs
// for FCM push only still seeds into Postgres.
const owner=process.env.GYMOS_DEMO_STORAGE_KEY,count=Number(process.env.GYMOS_DEMO_COUNT??20),output=resolve(process.env.GYMOS_DEMO_OUTPUT_DIR??'.demo-artifacts');
if(!owner||!process.argv.includes('--confirm-test-club')||!Number.isInteger(count)||count<1||count>2000)throw Error('Set GYMOS_DEMO_STORAGE_KEY and pass --confirm-test-club for an isolated test club only.');
mkdirSync(output,{recursive:true});const backup=join(output,'GymOS_Demo_Before_Seed.json'),now=new Date().toISOString();

async function read(){
 if(isFirestorePersistence())return readEntitySpace(owner);
 const row=await withScope(owner,async c=>(await c.query('SELECT payload,revision FROM gymos.gym_states WHERE user_id=$1',[owner])).rows[0]);
 if(!row)throw Error('Test club not found');
 const state=JSON.parse(row.payload);
 return state._entityStorage===1?readEntitySpace(owner):{state:normalize(state),revision:row.revision};
}

// Snapshot of the sign-in credentials of pre-existing (non-demo) members, so
// the run can prove it did not touch them. Firestore stores one document per
// member; Postgres stores rows in gymos.member_code_access.
async function protectedAccessSnapshot(ids){
 if(isFirestorePersistence()){
  const {memberAccessRef}=await import('../app/lib/firebase-member-auth.ts');
  const docs=await Promise.all(ids.map(id=>memberAccessRef(owner,id).get()));
  return docs.map((doc,index)=>({member_id:ids[index],data:doc.exists?doc.data():null}));
 }
 return withScope(owner,async c=>(await c.query('SELECT member_id,pin_hash,version FROM gymos.member_code_access WHERE owner_id=$1 AND member_id=ANY($2::text[]) ORDER BY member_id',[owner,ids])).rows);
}

try{
 const initial=await read();
 if(!/اختبار|تجريبي|demo|test/i.test(initial.state.settings.name)||initial.state.members.some(m=>!m.demo&&!/اختبار|تجريبي|demo|test/i.test(m.name)))throw Error('Refusing a club that may contain real members');
 const protectedIds=initial.state.members.filter(m=>!m.id.startsWith(DEMO_PREFIX)).map(m=>m.id);
 const protectedAccess=await protectedAccessSnapshot(protectedIds);
 if(!existsSync(backup))writeFileSync(backup,JSON.stringify({owner,...initial},null,2));
 for(let target=Math.min(Math.max(100,initial.state.members.filter(m=>m.id.startsWith(DEMO_PREFIX)).length),count);target<=count;target=Math.min(target+100,count)){
  const current=await read(),next=completeDemo(current.state,target,now);
  if(JSON.stringify(current.state)!==JSON.stringify(next)){
   if(!await persistSpace(owner,current,next))throw Error('Concurrent change: rerun to safely resume');
  }
  console.log(JSON.stringify({fictionalMembers:next.members.filter(m=>m.id.startsWith(DEMO_PREFIX)).length,totalMembers:next.members.length,target:count}));
  if(target===count)break;
 }
 const final=await read();
 const afterAccess=await protectedAccessSnapshot(protectedIds);
 if(JSON.stringify(protectedAccess)!==JSON.stringify(afterAccess))throw Error('Existing sign-in records changed unexpectedly');
 writeFileSync(join(output,'GymOS_Demo_Complete_Backup.json'),JSON.stringify(final.state));
 const report={owner,provider:isFirestorePersistence()?'firebase':'postgres',createdAt:now,fictionalMembers:final.state.members.filter(m=>m.id.startsWith(DEMO_PREFIX)).length,totalMembers:final.state.members.length,visits:final.state.visits.length,invoices:final.state.invoices?.length,payments:final.state.payments.length,announcements:final.state.announcements?.length,programs:final.state.programs?.length,products:final.state.products?.length,coaching:final.state.coaching?.length,employees:final.state.hr?.employees.length??0,purchases:final.state.financeBook?.purchases.length??0,expenses:final.state.financeBook?.expenses.length??0,manualTemplates:final.state.manualWhatsApp?.length??0,productsWithImages:final.state.products?.filter(p=>p.photo).length??0,realMessagingConnectionsCreated:false,preservedExistingSignIn:true,preservedExistingMembers:initial.state.members.filter(m=>!m.id.startsWith(DEMO_PREFIX)).every(m=>JSON.stringify(final.state.members.find(x=>x.id===m.id))===JSON.stringify(m))};
 writeFileSync(join(output,'GymOS_Demo_Seed_Verification.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{
 if(!isFirestorePersistence())await getPool().end();
}
