declare module 'web-push' {
 type Subscription={endpoint:string;expirationTime?:number|null;keys:{p256dh:string;auth:string}};
 const webPush:{
  setVapidDetails(subject:string,publicKey:string,privateKey:string):void;
  sendNotification(subscription:Subscription,payload?:string,options?:{TTL?:number;urgency?:'very-low'|'low'|'normal'|'high';timeout?:number;topic?:string}):Promise<{statusCode:number}>;
 };
 export default webPush;
}
