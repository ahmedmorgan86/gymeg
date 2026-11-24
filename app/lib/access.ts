export type Role='owner'|'manager'|'reception';
export function permitted(role:Role,_type:string){if(['demo.complete','design.save','card.restore','backup.restore','reception.settings','reception.permissions'].includes(_type))return role==='owner';return role==='owner'||role==='manager';}
export function fullAdministration(role:Role,scope:string[]|null,branches:string[]){return role==='owner'||(role==='manager'&&Array.isArray(scope)&&branches.every(id=>scope.includes(id)));}

export function receptionPermitted(role:Role,type:string,grants:string[]=[]){return permitted(role,type)||role==='manager'&&['card.restore','backup.restore'].includes(type)&&grants.includes(type)||role==='reception'&&['member.register','member.details','visit.add','visit.scan','visit.exit','payment.add','invoice.pay','card.replace','card.serial'].includes(type)&&grants.includes(type);}

/** Legacy (non-commercial) gym_access.branches boundary. null means every branch, so a malformed non-owner grant must never become null: anything that is not an array of strings fails closed to an empty scope. Owners keep unrestricted (null) unless they carry a valid array. */
export function legacyBranchScope(raw:unknown,role:Role):string[]|null{let value:unknown=raw;if(typeof raw==='string'){try{value=JSON.parse(raw);}catch{value=undefined;}}if(Array.isArray(value)&&value.every(x=>typeof x==='string'))return value as string[];return role==='owner'?null:[];}

/** Copy only. This never changes operation authorization. */
export function limitedReceptionNotice(role:string,grants:readonly string[]|undefined,writable:boolean,support:boolean){return role==='reception'&&Boolean(grants?.length)&&writable&&!support;}
