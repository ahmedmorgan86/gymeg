import {context,readSpace} from './server-workspace';
import {validBrandLogo} from './branding';
export async function currentBrand(request:Request){const ctx=await context();const expected=new URL(request.url).searchParams.get('owner');if(!ctx||expected!==ctx.tenantId)return null;const space=await readSpace(ctx.owner);const settings=space.state.settings;return{owner:ctx.tenantId,name:String(settings.name??'GymEG').slice(0,120),logo:validBrandLogo(settings.logo)?settings.logo:null};}
