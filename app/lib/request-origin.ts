// Forwarded host/proto headers are attacker-controlled unless a trusted proxy
// rewrites them. Only the request target and an explicit operator allowlist are
// accepted as evidence of origin; see GYMEG_TRUSTED_ORIGINS in the deploy guide.
export function sameOrigin(request:Request){
 const origin=request.headers.get('origin');if(!origin||origin==='null')return false;
 const target=new URL(request.url).origin;if(origin===target)return true;
 const allowlist=(process.env.GYMEG_TRUSTED_ORIGINS??'').split(',').map(value=>value.trim()).filter(Boolean);
 return allowlist.includes(origin);
}
// Rate limiting must never trust a header the caller can rotate. Platforms may
// opt in explicitly by setting GYMEG_TRUST_PROXY_IP=1 after verifying that their
// edge replaces x-vercel-forwarded-for / x-forwarded-for on every request.
export function requestClientIp(request:Request){
 if(process.env.GYMEG_TRUST_PROXY_IP!=='1')return 'unknown';
 const value=request.headers.get('x-vercel-forwarded-for')??request.headers.get('x-forwarded-for')??'unknown';
 const ip=value.split(',')[0]!.trim();
 return /^[a-fA-F0-9:.]{1,64}$/.test(ip)?ip:'unknown';
}
