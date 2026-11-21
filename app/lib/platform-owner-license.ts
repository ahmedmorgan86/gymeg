// Stable, verified platform-owner identity. Never trust a browser-supplied email or flag.
// The bound identity is the verified auth account ID (server-side env override per deployment,
// defaulting to the original platform owner). Never bind by email string or client claim.
export const PLATFORM_OWNER_ACCOUNT_ID='fbf6cf7d-0c30-487e-93b7-a2b772e524c8';
// Fail closed: a set-but-invalid override binds NO account (never falls back to any identity).
export function platformOwnerAccountId(){const override=process.env.GYMOS_PLATFORM_OWNER_ACCOUNT_ID;if(override===undefined)return PLATFORM_OWNER_ACCOUNT_ID;return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(override)?override:null;}
export const OWNER_FREE_PLAN='platform-owner-free';
export const OWNER_FREE_LIMITS={branches:100,members:10000,staff:1000};
export function ownerComplimentary(platform:boolean,userId:string){const bound=platformOwnerAccountId();return platform&&bound!==null&&userId===bound;}
