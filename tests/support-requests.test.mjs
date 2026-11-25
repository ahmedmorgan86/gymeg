import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canAccessSupportRequest,supportRequestUpdateRecipient} from '../app/lib/support-requests.ts';

const open={requester:'owner-a',assignee:null,title:'Example',status:'open',updatedAt:'2026-11-25T00:00:00Z'};
const active={...open,assignee:'assigned',status:'in_progress'};
const owner={id:'owner-a',platform:false};
const assigned={id:'assigned',platform:true};
const unrelated={id:'owner-b',platform:false};
const unassigned={id:'another-agent',platform:true};

test('request threads are private to their owner and platform staff with write scope restricted to the assignee',()=>{
 for(const action of ['read','reply','claim','resolve'])assert.equal(canAccessSupportRequest(active,unrelated,action),false);
 assert.equal(canAccessSupportRequest(active,owner,'reply'),true);
 assert.equal(canAccessSupportRequest(active,owner,'resolve'),false);
 assert.equal(canAccessSupportRequest(open,assigned,'claim'),true);
 assert.equal(canAccessSupportRequest(active,assigned,'resolve'),true);
 assert.equal(canAccessSupportRequest(active,unassigned,'read'),true);
 assert.equal(canAccessSupportRequest(active,unassigned,'reply'),false);
 assert.equal(canAccessSupportRequest(active,unassigned,'claim'),false);
 assert.equal(canAccessSupportRequest(active,{...assigned,platform:false},'reply'),false);
 assert.equal(canAccessSupportRequest({...active,status:'resolved'},owner,'reply'),false);
});

test('ticket alert recipients exclude unrelated accounts and the author',()=>{
 assert.equal(supportRequestUpdateRecipient(open,owner.id,'reply'),null);
 assert.equal(supportRequestUpdateRecipient(active,owner.id,'reply'),assigned.id);
 assert.equal(supportRequestUpdateRecipient(active,assigned.id,'reply'),owner.id);
 assert.equal(supportRequestUpdateRecipient(active,assigned.id,'resolve'),owner.id);
 assert.equal(supportRequestUpdateRecipient(open,assigned.id,'claim'),owner.id);
 assert.equal(supportRequestUpdateRecipient({...active,assignee:owner.id},owner.id,'reply'),null);
});
