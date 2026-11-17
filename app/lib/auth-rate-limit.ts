import {requestClientIp} from './request-origin';

// Best-effort, per-process limiter for unauthenticated auth endpoints.
//
// LIMITATION: every Node instance keeps its own map, so a multi-instance or
// serverless deployment enforces `limit x instances`, not a single global limit.
// Production platforms that need a global cap must replace this with a shared
// store (Redis/Upstash or a database counter). Supabase Auth still applies its
// own server-side rate limits; this module is defense in depth only.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 5000;

type Bucket = {hits:number;resetAt:number};
const buckets = new Map<string,Bucket>();

export type RateLimitDecision = {allowed:boolean;retryAfter:number};

function prune(now:number){
  if(buckets.size<MAX_ENTRIES)return;
  for(const [key,bucket] of buckets)if(now>=bucket.resetAt)buckets.delete(key);
  while(buckets.size>=MAX_ENTRIES){
    const oldest=buckets.keys().next().value;
    if(oldest===undefined)break;
    buckets.delete(oldest);
  }
}

export function consumeAuthRateLimit(scope:string,request:Request,email:string,limit:number,windowMs=WINDOW_MS,now=Date.now()):RateLimitDecision{
  const key=`${scope}|${requestClientIp(request)}|${email.trim().toLowerCase()}`;
  prune(now);
  let bucket=buckets.get(key);
  if(!bucket||now>=bucket.resetAt){bucket={hits:0,resetAt:now+windowMs};buckets.set(key,bucket);}
  bucket.hits++;
  if(bucket.hits>limit)return {allowed:false,retryAfter:Math.max(1,Math.ceil((bucket.resetAt-now)/1000))};
  return {allowed:true,retryAfter:0};
}

// Intended for tests and deliberate process-level resets; never exposed over HTTP.
export function resetAuthRateLimits(){buckets.clear();}
