// Stable, verified platform-owner identity. Never trust a browser-supplied email or flag.
// Every deployment MUST bind its owner explicitly via the server-only env
// GYMOS_PLATFORM_OWNER_ACCOUNT_ID (canonical UUID of the verified auth account).
// Absent or invalid binding fails closed: NO account is the platform owner.
// The constant below is the legacy deployment's historical binding, kept as
// documentation and for tests; it grants nothing unless a deployment sets it.
export const PLATFORM_OWNER_ACCOUNT_ID='fbf6cf7d-0c30-487e-93b7-a2b772e524c8';
export function platformOwnerAccountId(){const override=process.env.GYMOS_PLATFORM_OWNER_ACCOUNT_ID;return typeof override==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(override)?override:null;}
export const OWNER_FREE_PLAN='platform-owner-free';
export const OWNER_FREE_LIMITS={branches:100,members:10000,staff:1000};
export function ownerComplimentary(platform:boolean,userId:string){const bound=platformOwnerAccountId();return platform&&bound!==null&&userId===bound;}
