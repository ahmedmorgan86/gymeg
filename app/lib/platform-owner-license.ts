// Stable, verified platform-owner identity. Never trust a browser-supplied email or flag.
// The bound identity is the verified auth account ID (server-side env override per deployment,
// defaulting to the original platform owner). Never bind by email string or client claim.
export const PLATFORM_OWNER_ACCOUNT_ID='fbf6cf7d-0c30-487e-93b7-a2b772e524c8';
export function platformOwnerAccountId(){const override=process.env.GYMOS_PLATFORM_OWNER_ACCOUNT_ID;return typeof override==='string'&&/^[0-9a-f-]{36}$/i.test(override)?override:PLATFORM_OWNER_ACCOUNT_ID;}
export const OWNER_FREE_PLAN='platform-owner-free';
export const OWNER_FREE_LIMITS={branches:100,members:10000,staff:1000};
export function ownerComplimentary(platform:boolean,userId:string){return platform&&userId===platformOwnerAccountId();}
