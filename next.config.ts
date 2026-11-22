import type {NextConfig} from 'next';
import {join} from 'node:path';
const securityHeaders=[
 {key:'X-Content-Type-Options',value:'nosniff'},
 {key:'X-Frame-Options',value:'DENY'},
 {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
 {key:'Permissions-Policy',value:'camera=(self), microphone=(self), geolocation=(), payment=()'},
 {key:'Strict-Transport-Security',value:'max-age=63072000; includeSubDomains; preload'},
 {key:'Cross-Origin-Resource-Policy',value:'same-site'},
 // Enforced CSP is structural only: it omits script, style and default
 // directives, but it still affects embedding (frame-ancestors, matching
 // X-Frame-Options DENY), plugin/object loading and <base> URLs. The full
 // resource policy below stays Report-Only (open compatibility work, not a
 // completed outcome). Enforcing script-src has known constraints: Next
 // inline bootstrap scripts, inline style attributes, and a Zod 'new Function'
 // probe that reports under a strict policy. Nonce-based CSP needs dynamic
 // rendering (Next CSP guide); the same guide describes an experimental
 // hash/SRI alternative that keeps static generation. Neither option, nor
 // other alternatives, has been assessed for compatibility here.
 {key:'Content-Security-Policy',value:"frame-ancestors 'none'; object-src 'none'; base-uri 'self'"},
 {key:'Content-Security-Policy-Report-Only',value:"default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests"}
];
const config:NextConfig={output:'standalone',images:{dangerouslyAllowSVG:true,contentDispositionType:'inline',contentSecurityPolicy:"default-src 'none'; style-src 'unsafe-inline'; sandbox;",localPatterns:[{pathname:'/images/**',search:'?v=20261029-gymeg-r2'},{pathname:'/icons/**',search:'?v=20261029-gymeg-r2'},{pathname:'/icons/**',search:'?v=20261030-role-icons'},{pathname:'/**',search:''},{pathname:'/images/**',search:'?v=20261027'},{pathname:'/images/**',search:'?v=20261028-gymeg'},{pathname:'/images/**',search:'?v=20261029-gymeg'},{pathname:'/icons/**',search:'?v=20261027'},{pathname:'/icons/**',search:'?v=20261028-gymeg'},{pathname:'/icons/**',search:'?v=20261029-gymeg'}]},async headers(){return[{source:'/:path*',headers:securityHeaders},{source:'/downloads/:file*.apk',headers:[{key:'Content-Type',value:'application/vnd.android.package-archive'},{key:'Content-Disposition',value:'attachment'}]}];},serverExternalPackages:['firebase-admin'],poweredByHeader:false,outputFileTracingRoot:process.cwd(),outputFileTracingIncludes:{'/*':['./public/icons/icon-512.png']},webpack(config){
  // Human's node export otherwise pulls native TensorFlow into the SSR build.
  // Camera inference is loaded only on demand in the client component.
  config.resolve.alias={...config.resolve.alias,'@vladmandic/human$':join(process.cwd(),'node_modules/@vladmandic/human/dist/human.esm.js')};
  return config;
}};
export default config;
