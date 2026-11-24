// Adapter with the PGlite test-db surface (query, exec, transaction) over a real Postgres. Refuses any database not named rehearsal_*.
import pg from 'pg';
export async function rehearsalDb(url){
  let name='';try{name=decodeURIComponent(new URL(url).pathname.replace(/^\//,''));}catch{}
  if(!/^rehearsal_/.test(name))throw new Error('refusing: database name must start with rehearsal_');
  const pool=new pg.Pool({connectionString:url,max:4});
  const run=(c,s,v)=>c.query(s,v);
  return{pool,
    query:(s,v)=>pool.query(s,v),exec:s=>pool.query(s),
    async transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn({query:(s,v)=>c.query(s,v)});await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}},
    async reset(){await pool.query("DELETE FROM gymos.gym_member_summaries WHERE owner_id='E'");for(const t of ['gym_member_summary_dirty','gym_member_summary_ready','gym_entity_counters','gym_entities'])await pool.query(`DELETE FROM gymos.${t} WHERE owner_id='E'`);await pool.query("DELETE FROM gymos.gym_states WHERE user_id='E'");},
    close:()=>pool.end()};
}
