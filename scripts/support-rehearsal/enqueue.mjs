// Only synthetic admission is supported until user-visible event semantics are grounded.
export async function enqueueSynthetic(client,{eventId,kind='synthetic.acceptance',enabled=false}){
 if(!enabled)return{status:'disabled'};
 if(typeof eventId!=='string'||!/^synthetic:[a-zA-Z0-9-]{16,100}$/.test(eventId)||kind!=='synthetic.acceptance')throw Error('synthetic event required');
 // Caller owns transaction. Do not autocommit an alert outside the business transaction.
 const r=await client.query('SELECT gymos.support_alert_enqueue($1,$2) AS queued',[eventId,kind]);
 return{status:r.rows[0].queued?'queued':'duplicate'};
}
