// UNFINISHED DRAFT, untested, not wired. Do not use for production.
// HELD lifecycle wrapper, no connection factory or credentials supplied.
// Never retries. A COMMIT acknowledgement failure is outcomeUnknown, not rollback.
export async function withSenderClient(acquire,work){
 let client;try{client=await acquire()}catch{throw Error('sender connection unavailable')}
 let uncertain=false,begun=false;
 const scope={query:(...args)=>client.query(...args),begin:async()=>{await client.query('BEGIN');begun=true},commit:async()=>{uncertain=true;await client.query('COMMIT');uncertain=false;begun=false}};
 try{return await work(scope)}catch(error){
  if(uncertain){const wrapped=Error('sender commit outcome unknown; reconcile before any retry');wrapped.outcomeUnknown=true;throw wrapped;}
  if(begun){try{await client.query('ROLLBACK');begun=false}catch{uncertain=true;}}
  throw error;
 }finally{client.release(uncertain||begun);}
}
