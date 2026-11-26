import type {NextConfig} from 'next';
import {join} from 'node:path';
const securityHeaders=[
 {key:'X-Content-Type-Options',value:'nosniff'},
 {key:'X-Frame-Options',value:'DENY'},
 {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
 {key:'Permissions-Policy',value:'camera=(self), microphone=(self), geolocation=(), payment=()'},
 {key:'Strict-Transport-Security',value:'max-age=63072000; includeSubDomains; preload'},
 {key:'Cross-Origin-Resource-Policy',value:'same-site'}
 // Content-Security-Policy (with per-request script nonce) is enforced dynamically in proxy.ts.
];
const config:NextConfig={output:'standalone',images:{dangerouslyAllowSVG:true,contentDispositionType:'inline',contentSecurityPolicy:"default-src 'none'; style-src 'unsafe-inline'; sandbox;",localPatterns:[{pathname:'/images/**',search:'?v=20261029-gymeg-r2'},{pathname:'/icons/**',search:'?v=20261029-gymeg-r2'},{pathname:'/icons/**',search:'?v=20261030-role-icons'},{pathname:'/**',search:''},{pathname:'/images/**',search:'?v=20261027'},{pathname:'/images/**',search:'?v=20261028-gymeg'},{pathname:'/images/**',search:'?v=20261029-gymeg'},{pathname:'/icons/**',search:'?v=20261027'},{pathname:'/icons/**',search:'?v=20261028-gymeg'},{pathname:'/icons/**',search:'?v=20261029-gymeg'}]},async headers(){return[{source:'/:path*',headers:securityHeaders},{source:'/(fonts|icons|images|music|voices)/:path*',headers:[{key:'Cache-Control',value:'public, max-age=31536000, immutable'}]},{source:'/manuals/:path*',headers:[{key:'Cache-Control',value:'public, max-age=3600, stale-while-revalidate=86400'}]},{source:'/downloads/:file*.apk',headers:[{key:'Content-Type',value:'application/vnd.android.package-archive'},{key:'Content-Disposition',value:'attachment'},{key:'Cache-Control',value:'public, max-age=86400'}]}];},serverExternalPackages:['firebase-admin'],poweredByHeader:false,outputFileTracingRoot:process.cwd(),outputFileTracingIncludes:{'/*':['./public/icons/icon-512.png']},webpack(config){
  // Human's node export otherwise pulls native TensorFlow into the SSR build.
  // Camera inference is loaded only on demand in the client component.
  config.resolve.alias={...config.resolve.alias,'@vladmandic/human$':join(process.cwd(),'node_modules/@vladmandic/human/dist/human.esm.js')};
  return config;
}};
export default config;
