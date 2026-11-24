import {registerHooks} from 'node:module';
import './member-console-ui-loader.mjs';
registerHooks({load(url,ctx,next){
 if(url.endsWith('/app/lib/platform-alerts.ts'))return{format:'module',shortCircuit:true,source:'export const requestNotificationPermission=async()=>globalThis.__permResult;export const disablePushNotifications=async()=>true;'};
 return next(url,ctx);
}});
