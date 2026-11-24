const LABELS:Readonly<Record<string,readonly [string,string]>>=Object.freeze({cash:['نقدي','Cash'],card:['بطاقة','Card'],transfer:['تحويل','Transfer']});
// Display only. Own-property lookup, so a legacy or imported value such as "constructor" falls back to the raw text.
export function payMethodLabel(method:string,ar:boolean):string{return Object.prototype.hasOwnProperty.call(LABELS,method)?LABELS[method][ar?0:1]:method;}
