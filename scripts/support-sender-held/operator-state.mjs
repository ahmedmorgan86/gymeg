// Source-only operator aggregation. No IDs, payloads, token material or DB access.
// Admission is a business-transaction fact, never a delivery receipt.
export function summarizeDelivery({admitted,ledger}){
 if(!Number.isSafeInteger(admitted)||admitted<0||!Array.isArray(ledger)||ledger.length>admitted)throw Error('invalid delivery inventory');
 const out={admitted,awaitingClaim:admitted-ledger.length,pending:0,sending:0,transportAccepted:0,noRecipients:0,failed:0,deviceReceipt:'unverified'};
 for(const row of ledger){if(!row||!['pending','sending','accepted','no_recipients','failed'].includes(row.status))throw Error('invalid ledger status');const key={accepted:'transportAccepted',no_recipients:'noRecipients'}[row.status]??row.status;out[key]++;}
 return out;
}
