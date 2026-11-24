import {CommercialError} from './licensing.ts';

export function assertRequestTenant(request:Request,tenantId:string,commercial:boolean){
  if(!commercial)return;
  const header=request.headers.get('x-gymos-tenant');
  const isMutation=['POST','PUT','PATCH','DELETE'].includes(request.method);
  if(isMutation){
    if(header!==tenantId)throw new CommercialError('clubChanged',409);
  }else{
    if(header&&header!==tenantId)throw new CommercialError('clubChanged',409);
  }
}
