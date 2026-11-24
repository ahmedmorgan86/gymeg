// Source-only boundary. Deliberately no executable sender or network adapter.
export const approvedEvents=Object.freeze(['quote_requested','transfer_submitted']);
export function validateSenderEnvelope(value){
 if(!value||!approvedEvents.includes(value.eventKind)||typeof value.orderId!=='string'||!value.orderId||typeof value.recipientUserId!=='string'||!value.recipientUserId)throw Error('invalid approved event envelope');
 if(Object.keys(value).some(k=>!['eventKind','orderId','recipientUserId'].includes(k)))throw Error('unexpected event data');
 return Object.freeze({...value});
}
export async function main(){throw Error('HELD: no isolated sender adapter, custody or execution approval installed');}
if(import.meta.url===new URL(process.argv[1]??'', 'file:').href)await main();
