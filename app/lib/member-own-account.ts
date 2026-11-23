import {exactPrivateCredit} from './member-private-credit.ts';
// Exact member-session financial inputs. Never accepts a browser-selected id.
import type {Scope} from './member-console-source.ts';
import type {GymState} from './domain.ts';
import {invoiceOutstanding} from './member-ledger.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import {deadlineScope} from './deadline-scope.ts';
export const MEMBER_ACCOUNT_ROWS=5000;
export async function readOwnMemberAccount(scope:Scope,q:{owner:string;member:string;branch:string;deadline?:number}){
 return deadlineScope(scope,q.deadline??Date.now()+4000)(q.owner,async c=>{
  const version=await readOwnerVersion(c,q.owner);if(version===null)return{status:'unavailable',reason:'no-version'} as const;
  const meta=(await c.query('SELECT payload,revision FROM gymos.gym_states WHERE user_id=$1',[q.owner])).rows[0] as {payload:string;revision:number}|undefined;
  if(!meta)return{status:'notFound'} as const;const metadata=JSON.parse(meta.payload);if(metadata._entityStorage!==1)return{status:'unavailable',reason:'legacy-layout'} as const;
  const member=(await c.query("SELECT payload->'id' AS id,payload->'branch' AS branch,payload->'demo' AS demo,payload->'archived' AS archived FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members' AND entity_id=$2 AND branch=$3",[q.owner,q.member,q.branch])).rows[0] as {id:unknown;branch:unknown;demo:unknown;archived:unknown}|undefined;
  if(!member||member.id!==q.member||member.branch!==q.branch||member.demo||member.archived)return{status:'notFound'} as const;
  const own=async(collection:string)=>(await c.query(`SELECT payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 AND branch=$3 AND demand_member_hash IS NOT NULL AND demand_member_hash=md5($4) AND payload->>'member'=$4 AND jsonb_typeof(payload->'member')='string' ORDER BY position,entity_id LIMIT ${MEMBER_ACCOUNT_ROWS+1}`,[q.owner,collection,q.branch,q.member])).rows.map(r=>(r as {payload:unknown}).payload);
  const payments=await own('payments'),invoices=await own('invoices');
  if(payments.length>MEMBER_ACCOUNT_ROWS||invoices.length>MEMBER_ACCOUNT_ROWS)return{status:'unavailable',reason:'row-cap'} as const;
  const mini={payments,invoices} as unknown as GymState;
  const privateCredit=await exactPrivateCredit(c,q.owner,payments as GymState['payments'],q.member,q.branch);if(privateCredit.status!=='ok')return privateCredit;
  const credit=privateCredit.credit,outstanding=(invoices as NonNullable<GymState['invoices']>).filter(i=>!i.voided).reduce((n,i)=>n+invoiceOutstanding(mini,i),0);
  if((await readOwnerVersion(c,q.owner))!==version)return{status:'unavailable',reason:'changed'} as const;
  return{status:'ok',memberId:q.member,branch:q.branch,revision:meta.revision,version,payments:payments as GymState['payments'],invoices:invoices as NonNullable<GymState['invoices']>,credit,outstanding} as const;
 });
}
